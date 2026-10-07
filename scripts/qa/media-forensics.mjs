/**
 * Media forensics for S6_cut content-authenticity acceptance.
 *
 * Every measurement here is taken from decoded pixels and decoded audio
 * samples, never from container metadata alone: a technically valid MP4 can
 * still hold a black, frozen, or placeholder picture. FFmpeg/FFprobe run inside
 * the S6_cut engine image so the check works on hosts without a local FFmpeg.
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";

const IMAGE = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";

/**
 * Mean absolute 8-bit difference, per pixel of a 128x128 luma plane, below
 * which a sampled pair counts as frozen. Calibrated on this fixture: a
 * still-image control measures ~0.02 and genuinely moving content ~6-30, so
 * 1.0 sits an order of magnitude clear of both.
 */
export const MOTION_FLOOR = 1.0;

/** Root directory bind-mounted into the helper container as /work. */
let mountRoot = null;
export function setMountRoot(root) { mountRoot = root; }

function containerPath(hostPath) {
  const rel = relative(mountRoot, hostPath);
  if (rel.startsWith("..")) throw new Error(`${hostPath} is outside the forensics mount root ${mountRoot}`);
  return `/work/${rel.split("\\").join("/")}`;
}

function dockerArgs(entrypoint) {
  return [
    "run", "--rm", "--network", "none", "--entrypoint", entrypoint,
    "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-e", "HOME=/tmp", "-v", `${mountRoot}:/work`, IMAGE,
  ];
}

function execute(entrypoint, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", [...dockerArgs(entrypoint), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${entrypoint} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function ffmpeg(args, options) {
  const result = await execute("ffmpeg", args, options);
  return result;
}

/** ffprobe -> parsed JSON of format and streams. */
export async function probe(file) {
  const { code, stdout, stderr } = await execute("ffprobe", [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", containerPath(file),
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${basename(file)}: ${stderr.slice(-500)}`);
  const raw = JSON.parse(stdout);
  const video = (raw.streams || []).find((stream) => stream.codec_type === "video") || null;
  const audio = (raw.streams || []).find((stream) => stream.codec_type === "audio") || null;
  const rate = video?.r_frame_rate?.split("/").map(Number);
  return {
    container: raw.format?.format_name || null,
    duration: Number(raw.format?.duration ?? video?.duration ?? 0),
    sizeBytes: Number(raw.format?.size ?? 0),
    bitRate: Number(raw.format?.bit_rate ?? 0),
    streamCount: (raw.streams || []).length,
    video: video && {
      codec: video.codec_name, width: video.width, height: video.height,
      pixelFormat: video.pix_fmt, frameRate: rate && rate[1] ? rate[0] / rate[1] : null,
      frames: video.nb_frames ? Number(video.nb_frames) : null,
      aspect: `${video.width}x${video.height}`,
    },
    audio: audio && {
      codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels,
      duration: Number(audio.duration ?? raw.format?.duration ?? 0),
    },
    raw,
  };
}

/**
 * Decode every packet of every stream to the null muxer. Anything FFmpeg
 * reports at error level here is real corruption, not a metadata quirk.
 */
export async function fullDecode(file) {
  const path = containerPath(file);
  const video = await ffmpeg(["-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-f", "null", "-"]);
  const probed = await probe(file);
  let audio = { code: 0, stderr: "" };
  if (probed.audio) {
    audio = await ffmpeg(["-v", "error", "-xerror", "-i", path, "-map", "0:a:0", "-f", "null", "-"]);
  }
  const messages = [video.stderr, audio.stderr].map((text) => text.trim()).filter(Boolean);
  return {
    ok: video.code === 0 && audio.code === 0 && messages.length === 0,
    videoExit: video.code,
    audioExit: audio.code,
    hasAudioStream: Boolean(probed.audio),
    errors: messages,
  };
}


/**
 * Accurate seek arguments.
 *
 * `-ss` before `-i` is fast but lands on the nearest keyframe, which on a
 * sparse-keyframe source (AV1 especially) can be many seconds away — enough to
 * make a contact sheet show the wrong moment. Coarse-seeking slightly early and
 * then discarding decoded frames with a second `-ss` after `-i` keeps the speed
 * and lands on the exact timestamp.
 */
function seekArgs(file, start) {
  if (!start || start <= 0) return { pre: [], post: [] };
  const lead = Math.min(start, 5);
  return { pre: ["-ss", String(start - lead)], post: ["-ss", String(lead)] };
}

/** Raw grayscale planes for `count` evenly spaced frames, each `size`x`size`. */
async function grayFrames(file, { count, size, start = 0, duration = null, crop = null }) {
  const scratch = `${dirname(file)}/.gray-${basename(file)}-${size}-${count}-${start}.raw`;
  await mkdir(dirname(scratch), { recursive: true });
  const span = duration ?? (await probe(file)).duration;
  // fps is chosen so the sampled frames span the requested window evenly.
  const fps = count / Math.max(0.001, span);
  const filters = [];
  if (crop) filters.push(`crop=${crop}`);
  filters.push(`fps=${fps.toFixed(6)}`, `scale=${size}:${size}:flags=bilinear`, "format=gray");
  const seek = seekArgs(file, start);
  const args = ["-v", "error", "-y", ...seek.pre, "-i", containerPath(file), ...seek.post];
  if (duration) args.push("-t", String(duration));
  args.push("-vf", filters.join(","), "-frames:v", String(count),
    "-f", "rawvideo", "-pix_fmt", "gray", containerPath(scratch));
  const result = await ffmpeg(args);
  if (result.code !== 0) throw new Error(`gray frame extraction failed: ${result.stderr.slice(-400)}`);
  const buffer = await readFile(scratch);
  const frameBytes = size * size;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= buffer.length; offset += frameBytes) {
    frames.push(buffer.subarray(offset, offset + frameBytes));
  }
  return frames;
}

/** Mean RGB of `count` frames sampled across a window, optionally cropped. */
async function rgbMeans(file, { count, start = 0, duration = null, crop = null }) {
  const size = 16;
  const scratch = `${dirname(file)}/.rgb-${basename(file)}-${count}.raw`;
  const span = duration ?? (await probe(file)).duration;
  const fps = count / Math.max(0.001, span);
  const filters = [];
  if (crop) filters.push(`crop=${crop}`);
  filters.push(`fps=${fps.toFixed(6)}`, `scale=${size}:${size}:flags=bilinear`, "format=rgb24");
  const seek = seekArgs(file, start);
  const args = ["-v", "error", "-y", ...seek.pre, "-i", containerPath(file), ...seek.post];
  if (duration) args.push("-t", String(duration));
  args.push("-vf", filters.join(","), "-frames:v", String(count),
    "-f", "rawvideo", "-pix_fmt", "rgb24", containerPath(scratch));
  const result = await ffmpeg(args);
  if (result.code !== 0) throw new Error(`rgb extraction failed: ${result.stderr.slice(-400)}`);
  const buffer = await readFile(scratch);
  const frameBytes = size * size * 3;
  const means = [];
  for (let offset = 0; offset + frameBytes <= buffer.length; offset += frameBytes) {
    let r = 0, g = 0, b = 0;
    for (let index = 0; index < frameBytes; index += 3) {
      r += buffer[offset + index];
      g += buffer[offset + index + 1];
      b += buffer[offset + index + 2];
    }
    const pixels = frameBytes / 3;
    means.push([r / pixels, g / pixels, b / pixels]);
  }
  return means;
}

// --- Perceptual hash (DCT-II over a 32x32 luma plane, 8x8 low-frequency) -----
const DCT_SIZE = 32;
const cosTable = (() => {
  const table = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let x = 0; x < DCT_SIZE; x += 1) {
    for (let u = 0; u < DCT_SIZE; u += 1) {
      table[x * DCT_SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
    }
  }
  return table;
})();

function perceptualHash(plane) {
  const rows = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let y = 0; y < DCT_SIZE; y += 1) {
    for (let u = 0; u < DCT_SIZE; u += 1) {
      let sum = 0;
      for (let x = 0; x < DCT_SIZE; x += 1) sum += plane[y * DCT_SIZE + x] * cosTable[x * DCT_SIZE + u];
      rows[y * DCT_SIZE + u] = sum;
    }
  }
  const coefficients = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < DCT_SIZE; y += 1) sum += rows[y * DCT_SIZE + u] * cosTable[y * DCT_SIZE + v];
      coefficients.push(sum);
    }
  }
  // The DC term encodes overall brightness only; excluding it from the median
  // keeps the hash about structure.
  const ac = coefficients.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = "";
  for (const value of coefficients) bits += value > median ? "1" : "0";
  return bits;
}

export function hammingDistance(a, b) {
  let distance = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) distance += 1;
  return distance;
}

/** Box-average a square plane down to DCT_SIZE for perceptual hashing. */
function downsampleToHashGrid(plane, size) {
  if (size === DCT_SIZE) return plane;
  const factor = size / DCT_SIZE;
  const out = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let y = 0; y < DCT_SIZE; y += 1) {
    for (let x = 0; x < DCT_SIZE; x += 1) {
      let sum = 0;
      let count = 0;
      for (let sy = Math.floor(y * factor); sy < Math.floor((y + 1) * factor); sy += 1) {
        for (let sx = Math.floor(x * factor); sx < Math.floor((x + 1) * factor); sx += 1) {
          sum += plane[sy * size + sx];
          count += 1;
        }
      }
      out[y * DCT_SIZE + x] = count ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Decoded-pixel metrics across the whole output or an optional crop:
 * luminance, near-black coverage, spatial variance, frame-to-frame motion,
 * frozen runs, and a perceptual hash per sample.
 *
 * Analysis runs on a 128x128 luma plane, not the 32x32 hash grid. Sampling is
 * rate-based so short clips and long sources are measured at the same temporal
 * resolution.
 */
const ANALYSIS_SIZE = 128;
export async function visualMetrics(file, { samplesPerSecond = 4, maxSamples = 240, crop = null } = {}) {
  const info = await probe(file);
  const samples = Math.max(4, Math.min(maxSamples, Math.round(info.duration * samplesPerSecond)));
  const frames = await grayFrames(file, { count: samples, size: ANALYSIS_SIZE, crop });
  if (frames.length < 2) throw new Error(`only ${frames.length} frames decoded from ${basename(file)}`);
  const perFrame = frames.map((plane) => {
    let total = 0;
    let nearBlack = 0;
    for (const value of plane) {
      total += value;
      if (value <= 16) nearBlack += 1;
    }
    const mean = total / plane.length;
    let variance = 0;
    for (const value of plane) variance += (value - mean) ** 2;
    return {
      luminance: mean,
      nearBlackFraction: nearBlack / plane.length,
      variance: variance / plane.length,
      hash: perceptualHash(downsampleToHashGrid(plane, ANALYSIS_SIZE)),
    };
  });
  const diffs = [];
  const localDiffs = [];
  const tileSize = ANALYSIS_SIZE / 4;
  for (let index = 1; index < frames.length; index += 1) {
    let delta = 0;
    let maxTileDelta = 0;
    for (let tileY = 0; tileY < 4; tileY += 1) {
      for (let tileX = 0; tileX < 4; tileX += 1) {
        let tileDelta = 0;
        for (let y = tileY * tileSize; y < (tileY + 1) * tileSize; y += 1) {
          for (let x = tileX * tileSize; x < (tileX + 1) * tileSize; x += 1) {
            const pixel = y * ANALYSIS_SIZE + x;
            const difference = Math.abs(frames[index][pixel] - frames[index - 1][pixel]);
            delta += difference;
            tileDelta += difference;
          }
        }
        maxTileDelta = Math.max(maxTileDelta, tileDelta / (tileSize * tileSize));
      }
    }
    diffs.push(delta / frames[index].length);
    localDiffs.push(maxTileDelta);
  }
  // Global motion describes how much of the frame changes; localized motion
  // records whether any 1/16 tile changes. The latter detects real movement in
  // a presenter inset without mistaking static screen-share panels for a frozen
  // output. A pair is locally frozen only when every tile stays below floor.
  const secondsPerSample = info.duration / Math.max(1, frames.length - 1);
  const longestRun = (values) => {
    let longest = 0;
    let run = 0;
    for (const value of values) {
      if (value < MOTION_FLOOR) { run += 1; longest = Math.max(longest, run); } else { run = 0; }
    }
    return longest * secondsPerSample;
  };
  const uniqueHashes = new Set(perFrame.map((entry) => entry.hash));
  const luminances = perFrame.map((entry) => entry.luminance);
  return {
    sampledFrames: frames.length,
    duration: info.duration,
    meanLuminance: luminances.reduce((a, b) => a + b, 0) / luminances.length,
    minLuminance: Math.min(...luminances),
    maxLuminance: Math.max(...luminances),
    maxNearBlackFraction: Math.max(...perFrame.map((entry) => entry.nearBlackFraction)),
    fractionOfFramesNearlyBlack: perFrame.filter((entry) => entry.nearBlackFraction > 0.98).length / perFrame.length,
    meanVariance: perFrame.reduce((sum, entry) => sum + entry.variance, 0) / perFrame.length,
    minVariance: Math.min(...perFrame.map((entry) => entry.variance)),
    samplesPerSecond: frames.length / Math.max(0.001, info.duration),
    analysisCrop: crop || "full-frame",
    motionFloor: MOTION_FLOOR,
    meanFrameDifference: diffs.reduce((a, b) => a + b, 0) / diffs.length,
    maxFrameDifference: Math.max(...diffs),
    minFrameDifference: Math.min(...diffs),
    movingSampleFraction: diffs.filter((diff) => diff >= MOTION_FLOOR).length / diffs.length,
    longestFrozenSeconds: longestRun(diffs),
    meanMaxTileFrameDifference: localDiffs.reduce((sum, diff) => sum + diff, 0) / localDiffs.length,
    maxTileMovingSampleFraction: localDiffs.filter((diff) => diff >= MOTION_FLOOR).length / localDiffs.length,
    longestLocallyFrozenSeconds: longestRun(localDiffs),
    distinctPerceptualHashes: uniqueHashes.size,
    perceptualHashes: perFrame.map((entry) => entry.hash),
  };
}

/** Ink coverage and its temporal variation inside a band and optional x-range. */
export async function bandActivity(file, { top, height, samples = 40, left = 0, cropWidth = null } = {}) {
  const info = await probe(file);
  const width = cropWidth ?? info.video.width;
  const crop = `${width}:${height}:${left}:${top}`;
  const size = 48;
  const scratch = `${dirname(file)}/.band-${basename(file)}.raw`;
  const fps = samples / Math.max(0.001, info.duration);
  const result = await ffmpeg([
    "-v", "error", "-y", "-i", containerPath(file),
    "-vf", `crop=${crop},fps=${fps.toFixed(6)},scale=${size}:${size}:flags=bilinear,format=gray`,
    "-frames:v", String(samples), "-f", "rawvideo", "-pix_fmt", "gray", containerPath(scratch),
  ]);
  if (result.code !== 0) throw new Error(`band extraction failed: ${result.stderr.slice(-400)}`);
  const buffer = await readFile(scratch);
  const frameBytes = size * size;
  const coverage = [];
  const hashes = [];
  for (let offset = 0; offset + frameBytes <= buffer.length; offset += frameBytes) {
    const plane = buffer.subarray(offset, offset + frameBytes);
    let bright = 0;
    let total = 0;
    for (const value of plane) { total += value; if (value >= 170) bright += 1; }
    coverage.push(bright / plane.length);
    // A coarse signature of the band, used to count how often its content changes.
    let signature = "";
    for (let index = 0; index < plane.length; index += 16) signature += plane[index] >= 128 ? "1" : "0";
    hashes.push(signature);
    void total;
  }
  const changes = hashes.filter((value, index) => index > 0 && value !== hashes[index - 1]).length;
  return {
    samples: coverage.length,
    meanCoverage: coverage.reduce((a, b) => a + b, 0) / coverage.length,
    maxCoverage: Math.max(...coverage),
    framesWithInk: coverage.filter((value) => value > 0.002).length,
    inkFraction: coverage.filter((value) => value > 0.002).length / coverage.length,
    distinctBandStates: new Set(hashes).size,
    stateChanges: changes,
  };
}

/** Decoded-sample audio analysis over the whole track plus three windows. */
export async function audioMetrics(file) {
  const info = await probe(file);
  if (!info.audio) return { hasAudio: false };
  const path = containerPath(file);
  const parseVolume = (text) => ({
    mean: Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(text)?.[1] ?? NaN),
    peak: Number(/max_volume:\s*(-?[\d.]+) dB/.exec(text)?.[1] ?? NaN),
    clippedSamples: Number(/histogram_0db:\s*(\d+)/.exec(text)?.[1] ?? 0),
  });
  const whole = await ffmpeg(["-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const overall = parseVolume(whole.stderr);
  const silence = await ffmpeg(["-i", path, "-map", "0:a:0", "-af", "silencedetect=n=-50dB:d=0.5", "-f", "null", "-"]);
  const silences = [];
  const pattern = /silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
  let match;
  while ((match = pattern.exec(silence.stderr)) !== null) {
    silences.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[2]) - Number(match[1]) });
  }
  const windowLength = Math.min(3, Math.max(0.5, info.audio.duration / 6));
  const windows = {};
  for (const [name, start] of [
    ["begin", 0],
    ["middle", Math.max(0, info.audio.duration / 2 - windowLength / 2)],
    ["nearEnd", Math.max(0, info.audio.duration - windowLength - 0.15)],
  ]) {
    const sample = await ffmpeg(["-ss", String(start), "-t", String(windowLength), "-i", path,
      "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
    windows[name] = { start, length: windowLength, ...parseVolume(sample.stderr) };
  }
  const totalSilent = silences.reduce((sum, entry) => sum + entry.duration, 0);
  return {
    hasAudio: true,
    codec: info.audio.codec,
    sampleRate: info.audio.sampleRate,
    channels: info.audio.channels,
    duration: info.audio.duration,
    meanVolumeDb: overall.mean,
    peakVolumeDb: overall.peak,
    fullScaleSamples: overall.clippedSamples,
    entirelySilent: !Number.isFinite(overall.peak) || overall.peak <= -70,
    silentSegments: silences,
    longestSilenceSeconds: silences.reduce((longest, entry) => Math.max(longest, entry.duration), 0),
    silentFraction: info.audio.duration > 0 ? totalSilent / info.audio.duration : 0,
    windows,
  };
}

/** Extract labelled still frames at fractional positions and a contact sheet. */
export async function extractFrames(file, outputDir, { fractions = [0.05, 0.25, 0.5, 0.75, 0.95], label = "" } = {}) {
  await mkdir(outputDir, { recursive: true });
  const info = await probe(file);
  const produced = [];
  for (const fraction of fractions) {
    const timestamp = Math.max(0, Math.min(info.duration - 0.05, info.duration * fraction));
    // Named by index and timestamp: two nearby fractions round to the same
    // percent, and a percent-only name silently overwrote one of the frames.
    const target = `${outputDir}/frame-${String(produced.length + 1).padStart(2, "0")}-t${timestamp.toFixed(2)}s.png`;
    const seek = seekArgs(file, timestamp);
    const result = await ffmpeg(["-v", "error", "-y", ...seek.pre, "-i", containerPath(file), ...seek.post,
      "-frames:v", "1", "-q:v", "2", containerPath(target)]);
    if (result.code !== 0) throw new Error(`frame extraction failed at ${fraction}: ${result.stderr.slice(-300)}`);
    produced.push({ fraction, timestamp, path: target });
  }
  const sheet = `${outputDir}/contact-sheet.png`;
  const inputs = produced.flatMap((frame) => ["-i", containerPath(frame.path)]);
  const labels = produced.map((frame, index) =>
    `[${index}:v]scale=320:-1,drawbox=x=0:y=0:w=iw:h=34:color=black@0.75:t=fill,` +
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `text='${label ? `${label} ` : ""}${Math.round(frame.fraction * 100)}%% t\\=${frame.timestamp.toFixed(2)}s':` +
    `fontcolor=white:fontsize=20:x=8:y=6[v${index}]`).join(";");
  const chain = `${labels};${produced.map((_, index) => `[v${index}]`).join("")}hstack=inputs=${produced.length}[out]`;
  const sheetResult = await ffmpeg(["-v", "error", "-y", ...inputs, "-filter_complex", chain, "-map", "[out]",
    "-frames:v", "1", containerPath(sheet)]);
  if (sheetResult.code !== 0) throw new Error(`contact sheet failed: ${sheetResult.stderr.slice(-400)}`);
  return { frames: produced, contactSheet: sheet };
}

/**
 * Prove an output came from a specific source range.
 *
 * The renderer fits the whole landscape source inside the vertical canvas over
 * an undarkened Gaussian-blurred backdrop, so the comparison crops the output back down to that
 * foreground band before hashing. Captions are burned in below the band and do
 * not contaminate it.
 */
/**
 * Gray plane and mean RGB for ONE frame, seeked accurately to `time`.
 *
 * Correspondence pairs frames from two different files, so each side has to
 * land on the timestamp actually being compared. The `fps` filter cannot do
 * that: it emits on its own grid rather than from the seek point, which put the
 * source samples up to ~1.9s away from the frame the report claimed they were
 * (proved against a fixture that burns its own timecode into the picture). That
 * is invisible on slow footage and catastrophic on fast-moving content. Sampling
 * one frame per accurate seek is exact, and eight seeks per window is cheap.
 *
 * The aggregate metrics (brightness, variance, motion, caption ink) do not pair
 * frames across files, so they keep the faster single-pass `fps` sampling.
 */
async function frameAt(file, time, { size, crop }) {
  const scratch = `${dirname(file)}/.at-${basename(file)}-${size}-${time.toFixed(3)}.raw`;
  await mkdir(dirname(scratch), { recursive: true });
  const filters = [];
  if (crop) filters.push(`crop=${crop}`);
  filters.push(`scale=${size}:${size}:flags=bilinear`, "format=gray");
  const seek = seekArgs(file, time);
  const result = await ffmpeg(["-v", "error", "-y", ...seek.pre, "-i", containerPath(file), ...seek.post,
    "-vf", filters.join(","), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray",
    containerPath(scratch)]);
  if (result.code !== 0) throw new Error(`frame extraction at ${time}s failed: ${result.stderr.slice(-300)}`);
  const buffer = await readFile(scratch);
  await rm(scratch, { force: true });
  return buffer.length >= size * size ? buffer.subarray(0, size * size) : null;
}

/** Mean RGB of one accurately seeked frame. */
async function colourAt(file, time, { crop }) {
  const size = 16;
  const scratch = `${dirname(file)}/.rgbat-${basename(file)}-${time.toFixed(3)}.raw`;
  await mkdir(dirname(scratch), { recursive: true });
  const filters = [];
  if (crop) filters.push(`crop=${crop}`);
  filters.push(`scale=${size}:${size}:flags=bilinear`, "format=rgb24");
  const seek = seekArgs(file, time);
  const result = await ffmpeg(["-v", "error", "-y", ...seek.pre, "-i", containerPath(file), ...seek.post,
    "-vf", filters.join(","), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24",
    containerPath(scratch)]);
  if (result.code !== 0) throw new Error(`colour extraction at ${time}s failed: ${result.stderr.slice(-300)}`);
  const buffer = await readFile(scratch);
  await rm(scratch, { force: true });
  if (buffer.length < size * size * 3) return null;
  const totals = [0, 0, 0];
  for (let offset = 0; offset + 3 <= size * size * 3; offset += 3) {
    totals[0] += buffer[offset]; totals[1] += buffer[offset + 1]; totals[2] += buffer[offset + 2];
  }
  return totals.map((total) => total / (size * size));
}

export async function sourceCorrespondence(output, source, { sourceStart, sourceEnd, samples = 6 }) {
  const outputInfo = await probe(output);
  const sourceInfo = await probe(source);
  const scale = outputInfo.video.width / sourceInfo.video.width;
  const bandHeight = Math.round((sourceInfo.video.height * scale) / 2) * 2;
  const bandTop = Math.round((outputInfo.video.height - bandHeight) / 2);
  const foregroundCrop = `${outputInfo.video.width}:${bandHeight}:0:${bandTop}`;
  const span = Math.max(0.1, sourceEnd - sourceStart);

  // Pair each output frame with the source frame at the matching fraction of
  // the window, and seek both accurately so the pair really is the same moment.
  const outputSpan = Math.max(0.1, outputInfo.duration);
  const fractions = Array.from({ length: samples }, (_, index) => index / Math.max(1, samples - 1));
  const times = fractions.map((fraction) => ({
    output: Math.min(outputSpan - 0.05, outputSpan * fraction),
    source: Math.min(sourceEnd - 0.05, sourceStart + span * fraction),
  }));
  const outputFrames = [];
  const sourceFrames = [];
  const outputColours = [];
  const sourceColours = [];
  for (const time of times) {
    outputFrames.push(await frameAt(output, time.output, { size: DCT_SIZE, crop: foregroundCrop }));
    sourceFrames.push(await frameAt(source, time.source, { size: DCT_SIZE, crop: null }));
    outputColours.push(await colourAt(output, time.output, { crop: foregroundCrop }));
    sourceColours.push(await colourAt(source, time.source, { crop: null }));
  }

  const pairs = times.filter((_, index) => outputFrames[index] && sourceFrames[index]).length;
  const comparisons = [];
  for (let index = 0; index < pairs; index += 1) {
    const outputHash = perceptualHash(outputFrames[index]);
    const sourceHash = perceptualHash(sourceFrames[index]);
    const colourDistance = outputColours[index] && sourceColours[index]
      ? Math.sqrt(outputColours[index].reduce((sum, value, channel) => sum + (value - sourceColours[index][channel]) ** 2, 0))
      : null;
    comparisons.push({
      index,
      sourceTime: times[index].source,
      outputTime: times[index].output,
      hammingDistance: hammingDistance(outputHash, sourceHash),
      colourDistance,
      outputColour: outputColours[index]?.map((value) => Math.round(value)),
      sourceColour: sourceColours[index]?.map((value) => Math.round(value)),
    });
  }
  const distances = comparisons.map((entry) => entry.hammingDistance);
  const colours = comparisons.map((entry) => entry.colourDistance).filter((value) => value !== null);
  return {
    foregroundCrop,
    sourceStart,
    sourceEnd,
    comparedFrames: pairs,
    meanHammingDistance: distances.reduce((a, b) => a + b, 0) / Math.max(1, distances.length),
    maxHammingDistance: Math.max(...distances),
    meanColourDistance: colours.reduce((a, b) => a + b, 0) / Math.max(1, colours.length),
    maxColourDistance: Math.max(...colours),
    comparisons,
  };
}

/** Classify sampled output frames against the fixture's known section colours. */
export async function sectionProfile(output, sections, { samples = 24, crop = null } = {}) {
  const info = await probe(output);
  let foregroundCrop = crop;
  if (!foregroundCrop && info.video.height > info.video.width) {
    const bandHeight = Math.round((info.video.width * 9) / 16 / 2) * 2;
    foregroundCrop = `${info.video.width}:${bandHeight}:0:${Math.round((info.video.height - bandHeight) / 2)}`;
  }
  const means = await rgbMeans(output, { count: samples, crop: foregroundCrop });
  return means.map((colour, index) => {
    let best = null;
    for (const section of sections) {
      const distance = Math.sqrt(section.rgb.reduce((sum, value, channel) => sum + (value - colour[channel]) ** 2, 0));
      if (!best || distance < best.distance) best = { name: section.name, distance };
    }
    return {
      index,
      time: (info.duration * index) / Math.max(1, samples - 1),
      colour: colour.map((value) => Math.round(value)),
      section: best.name,
      distance: Number(best.distance.toFixed(2)),
    };
  });
}
