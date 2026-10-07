/**
 * Content validation for the S6_cut YouTube-import acceptance run.
 *
 * Proves from decoded pixels and decoded audio that each downloaded output is
 * newly rendered from the imported YouTube source: changing foreground
 * regions, the requested 9:16 geometry, audio carried through, captions where
 * promised, and frames that match the source range the job reported rather than
 * an unrelated one.
 *
 * Thresholds are the same control-anchored limits used by the content
 * authenticity run (see scripts/qa/verify-outputs.mjs and
 * test-artifacts/content-authenticity/reports/calibration.json). Nothing here
 * records signed URLs, cookies, or request headers.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import {
  setMountRoot, probe, fullDecode, visualMetrics, audioMetrics, extractFrames,
  sourceCorrespondence, bandActivity, MOTION_FLOOR,
} from "./media-forensics.mjs";

const root = resolve(process.env.S6_YOUTUBE_ROOT || "test-artifacts/youtube-import");
setMountRoot(root);

const LIMITS = {
  maxNearlyBlackFrameFraction: 0.5,   // all-black control measured 1.00
  minMeanLuminance: 12,               // all-black control measured 2.0
  minMeanVariance: 100,               // all-black control measured 0
  minMeanFrameDifference: 0.5,        // frozen control measured 0.001 (max 0.04)
  minLocalizedMovingSampleFraction: 0.5, // frozen control measured 0.00
  maxFrozenSeconds: 3.0,
  minDistinctHashFraction: 0.1,       // frozen control produced 1 hash from 40
  minPeakDb: -50,                     // silent control measured -91 dB
  minMeanDb: -45,
  maxSilentFraction: 0.6,
  maxCorrespondenceColourDistance: 30,
  minDecoyColourMargin: 3.0,
  maxCorrespondenceHamming: 16,
  minCaptionInkFraction: 0.15,        // uncaptioned control measured 0.00
  minCaptionDistinctStates: 4,
};

const failures = [];
const warnings = [];
function check(condition, message, detail) {
  if (!condition) failures.push({ message, detail });
  return Boolean(condition);
}
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const ASPECTS = { "9:16": [1080, 1920] };

/** Locate the imported source preserved from the throwaway dataset. */
async function findImportedSource() {
  const dir = join(root, "imported-source");
  let entries = [];
  try { entries = await readdir(dir); } catch { return null; }
  const media = entries.filter((entry) => /\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(entry));
  if (!media.length) return null;
  // Every job imports the same video; the largest file is the merged source.
  let best = null;
  for (const entry of media) {
    const path = join(dir, entry);
    const info = await probe(path);
    if (!best || info.sizeBytes > best.info.sizeBytes) best = { path, info };
  }
  return best;
}

async function verifyClip(clip, context) {
  const label = `${context.mode} clip ${clip.index}`;
  const file = clip.downloadPath;
  const outputDir = join(context.outputDir, `clip-${clip.index}-analysis`);
  await mkdir(outputDir, { recursive: true });
  const report = { label, file: basename(file), index: clip.index };

  const bytes = await readFile(file);
  report.sizeBytes = bytes.length;
  report.sha256 = sha256(bytes);
  check(bytes.length > 50_000, `${label}: downloaded file has a meaningful size`, `${bytes.length} bytes`);
  check(report.sha256 === clip.sha256, `${label}: browser download matches the re-read file`);
  if (context.sourceSha) {
    check(report.sha256 !== context.sourceSha, `${label}: output is not the imported source`, report.sha256);
  }

  const info = await probe(file);
  report.probe = {
    container: info.container, duration: info.duration, streamCount: info.streamCount,
    video: info.video, audio: info.audio, sizeBytes: info.sizeBytes, bitRate: info.bitRate,
    displayAspectRatio: info.video ? `${info.video.width}:${info.video.height}` : null,
  };
  await writeFile(join(outputDir, "ffprobe.json"), JSON.stringify(info.raw, null, 2));
  check(Boolean(info.video), `${label}: has a video stream`);
  check(Boolean(info.audio), `${label}: has an audio stream`);
  check(info.streamCount >= 2, `${label}: contains both required streams`, `${info.streamCount} streams`);
  check(info.duration > 0 && Number.isFinite(info.duration), `${label}: plausible duration`, `${info.duration}s`);

  const expected = ASPECTS[context.aspect];
  check(info.video.width === expected[0] && info.video.height === expected[1],
    `${label}: output dimensions are the requested ${context.aspect}`,
    `${info.video.width}x${info.video.height}`);
  if (context.sourceInfo) {
    check(info.video.width !== context.sourceInfo.video.width || info.video.height !== context.sourceInfo.video.height,
      `${label}: output is not the untouched source frame size`,
      `${info.video.width}x${info.video.height} vs source ${context.sourceInfo.video.width}x${context.sourceInfo.video.height}`);
  }
  if (Number.isFinite(clip.sourceStart) && Number.isFinite(clip.sourceEnd)) {
    const span = clip.sourceEnd - clip.sourceStart;
    report.boundarySpan = span;
    check(Math.abs(info.duration - span) <= Math.max(1.0, span * 0.12),
      `${label}: duration agrees with its reported source boundaries`,
      `output ${info.duration.toFixed(2)}s vs boundaries ${span.toFixed(2)}s`);
  }

  const decode = await fullDecode(file);
  report.decode = decode;
  await writeFile(join(outputDir, "decode.json"), JSON.stringify(decode, null, 2));
  check(decode.ok, `${label}: decodes completely without corruption`, decode.errors.join(" | "));

  // Motion is judged on the actual 16:9 source-picture band. The portrait
  // canvas fills its upper/lower areas with a deliberately blurred still of
  // the same frame, which otherwise dilutes movement in screen-share videos.
  const foregroundHeight = Math.round((info.video.width * 9 / 16) / 2) * 2;
  const foregroundTop = Math.round((info.video.height - foregroundHeight) / 2);
  const foregroundCrop = info.video.height > info.video.width
    ? `${info.video.width}:${foregroundHeight}:0:${foregroundTop}`
    : null;
  const visual = await visualMetrics(file, { crop: foregroundCrop });
  report.visual = { ...visual, perceptualHashes: undefined, hashCount: visual.perceptualHashes.length };
  await writeFile(join(outputDir, "visual-metrics.json"), JSON.stringify(visual, null, 2));
  check(visual.fractionOfFramesNearlyBlack <= LIMITS.maxNearlyBlackFrameFraction,
    `${label}: not predominantly black`, `${(visual.fractionOfFramesNearlyBlack * 100).toFixed(1)}% of frames`);
  check(visual.meanLuminance >= LIMITS.minMeanLuminance,
    `${label}: picture is not black`, `mean luminance ${visual.meanLuminance.toFixed(1)}`);
  check(visual.meanVariance >= LIMITS.minMeanVariance,
    `${label}: picture has spatial detail, not a flat placeholder`, `variance ${visual.meanVariance.toFixed(0)}`);
  check(visual.meanFrameDifference >= LIMITS.minMeanFrameDifference,
    `${label}: picture changes over time`, `mean frame difference ${visual.meanFrameDifference.toFixed(3)} (frozen control 0.001)`);
  check(visual.maxTileMovingSampleFraction >= LIMITS.minLocalizedMovingSampleFraction,
    `${label}: motion appears in a foreground region`, `${(visual.maxTileMovingSampleFraction * 100).toFixed(1)}% of sampled pairs exceed floor ${MOTION_FLOOR}`);
  check(visual.longestLocallyFrozenSeconds <= LIMITS.maxFrozenSeconds,
    `${label}: no long fully frozen run`, `${visual.longestLocallyFrozenSeconds.toFixed(2)}s with all 16 regions below floor`);
  check(visual.distinctPerceptualHashes / visual.sampledFrames >= LIMITS.minDistinctHashFraction,
    `${label}: frames are not effectively identical`,
    `${visual.distinctPerceptualHashes} distinct of ${visual.sampledFrames}`);

  const { frames, contactSheet } = await extractFrames(file, outputDir, { label: `C${clip.index}` });
  report.frames = frames.map((frame) => basename(frame.path));
  report.contactSheet = basename(contactSheet);

  const audio = await audioMetrics(file);
  report.audio = audio;
  await writeFile(join(outputDir, "audio-metrics.json"), JSON.stringify(audio, null, 2));
  if (audio.hasAudio) {
    check(!audio.entirelySilent, `${label}: audio is not entirely silent`, `peak ${audio.peakVolumeDb} dB`);
    check(audio.peakVolumeDb >= LIMITS.minPeakDb, `${label}: audio peak is audible`, `${audio.peakVolumeDb} dB`);
    check(audio.meanVolumeDb >= LIMITS.minMeanDb, `${label}: audio mean level is audible`, `${audio.meanVolumeDb} dB`);
    check(Math.abs(audio.duration - info.duration) <= 0.5,
      `${label}: audio duration matches video`, `${audio.duration}s vs ${info.duration}s`);
    check(audio.silentFraction <= LIMITS.maxSilentFraction,
      `${label}: speech is present rather than mostly silence`, `${(audio.silentFraction * 100).toFixed(1)}% silent`);
    const audible = Object.entries(audio.windows).filter(([, window]) => window.peak > -50).map(([name]) => name);
    report.audibleWindows = audible;
    check(audible.length >= 2, `${label}: audio present in at least two of begin/middle/end`, audible.join(","));
    // Abrupt truncation shows up as a dead final window under a live track.
    if (audio.windows.nearEnd.peak <= -70 && audio.windows.middle.peak > -30) {
      warnings.push(`${label}: final window is silent (peak ${audio.windows.nearEnd.peak} dB) — check for truncation`);
    }
    if (audio.windows.begin.peak <= -70) {
      warnings.push(`${label}: opening window is silent (peak ${audio.windows.begin.peak} dB)`);
    }
  }

  if (context.expectCaptions) {
    const bandTop = Math.round(info.video.height * 0.74);
    const bandHeight = Math.round(info.video.height * 0.20);
    const band = await bandActivity(file, { top: bandTop, height: bandHeight, samples: 48 });
    report.captions = { band: `${bandTop}+${bandHeight}`, ...band };
    await writeFile(join(outputDir, "caption-band.json"), JSON.stringify(report.captions, null, 2));
    check(band.inkFraction >= LIMITS.minCaptionInkFraction,
      `${label}: burned-in captions are visible`,
      `ink on ${(band.inkFraction * 100).toFixed(0)}% of frames (uncaptioned control 0%)`);
    check(band.distinctBandStates >= LIMITS.minCaptionDistinctStates,
      `${label}: caption text changes over time`, `${band.distinctBandStates} distinct states`);
    // The app's source-credit overlay is intentionally placed near the lower
    // right edge. Test the centered caption column so that attribution is not
    // mistaken for subtitle clipping; centered captions necessarily cross it.
    const edge = await bandActivity(file, {
      top: info.video.height - Math.round(info.video.height * 0.03),
      height: Math.round(info.video.height * 0.03),
      left: Math.round(info.video.width * 0.3),
      cropWidth: Math.round(info.video.width * 0.4),
      samples: 24,
    });
    report.captionEdge = { ...edge, region: "centered 40% of frame width" };
    check(edge.maxCoverage < 0.02,
      `${label}: captions are not clipped by the bottom frame edge`, `edge ink ${(edge.maxCoverage * 100).toFixed(2)}%`);
  }

  // --- Correspondence with the imported YouTube source ---------------------
  if (context.sourcePath && Number.isFinite(clip.sourceStart) && Number.isFinite(clip.sourceEnd)) {
    const claimed = await sourceCorrespondence(file, context.sourcePath, {
      sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, samples: 8,
    });
    const span = clip.sourceEnd - clip.sourceStart;
    let decoyStart = clip.sourceStart + span + 120;
    if (decoyStart + span > context.sourceInfo.duration) decoyStart = Math.max(0, clip.sourceStart - span - 120);
    const decoy = await sourceCorrespondence(file, context.sourcePath, {
      sourceStart: decoyStart, sourceEnd: decoyStart + span, samples: 8,
    });
    report.correspondence = { claimed, decoy, decoyStart };
    await writeFile(join(outputDir, "source-correspondence.json"), JSON.stringify(report.correspondence, null, 2));
    check(claimed.meanColourDistance <= LIMITS.maxCorrespondenceColourDistance,
      `${label}: output matches its reported source range`,
      `colour distance ${claimed.meanColourDistance.toFixed(2)} over ${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}s`);
    check(claimed.meanHammingDistance <= LIMITS.maxCorrespondenceHamming,
      `${label}: output structure matches its reported source range`,
      `hamming ${claimed.meanHammingDistance.toFixed(2)}`);
    check(decoy.meanColourDistance - claimed.meanColourDistance >= LIMITS.minDecoyColourMargin,
      `${label}: matches its own range better than an unrelated range`,
      `claimed ${claimed.meanColourDistance.toFixed(2)} vs decoy@${decoyStart.toFixed(1)}s ${decoy.meanColourDistance.toFixed(2)}`);
    // A side-by-side sheet so the match can also be judged by eye.
    await extractFrames(context.sourcePath, join(outputDir, "source-range"), {
      label: `SRC ${clip.sourceStart.toFixed(0)}-${clip.sourceEnd.toFixed(0)}s`,
      fractions: [0.05, 0.25, 0.5, 0.75, 0.95].map((fraction) =>
        (clip.sourceStart + span * fraction) / context.sourceInfo.duration),
    });
  }
  return report;
}

async function verifyManifest(name, options) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, "reports", `${name}.json`), "utf8")); } catch { return null; }
  const clips = [];
  for (const clip of manifest.clips) clips.push(await verifyClip(clip, options));
  if (clips.length > 1) {
    const digests = new Set(clips.map((clip) => clip.sha256));
    check(digests.size === clips.length, `${name}: outputs are not byte-identical duplicates`,
      `${digests.size} distinct of ${clips.length}`);
    const ranges = manifest.clips.map((clip) => `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`);
    check(new Set(ranges).size === ranges.length, `${name}: outputs use distinct source ranges`, ranges.join(" | "));
  }
  return { ...manifest, clips };
}

async function main() {
  const source = await findImportedSource();
  if (!source) {
    console.error("No imported YouTube source was preserved; correspondence cannot be proven.");
    process.exitCode = 1;
    return;
  }
  const sourceBytes = await readFile(source.path);
  const sourceSha = sha256(sourceBytes);
  const sourceDecode = await fullDecode(source.path);
  console.log(`imported source: ${source.info.video.width}x${source.info.video.height} `
    + `${source.info.video.codec}/${source.info.audio?.codec || "none"} ${source.info.duration.toFixed(2)}s `
    + `${(source.info.sizeBytes / 1024 / 1024).toFixed(1)}MB fps=${source.info.video.frameRate?.toFixed(2)} `
    + `decode=${sourceDecode.ok ? "clean" : "CORRUPT"}`);
  check(source.info.sizeBytes > 0, "imported source has nonzero size");
  check(Boolean(source.info.video), "imported source has a decodable video stream");
  check(Boolean(source.info.audio), "imported source has an audio stream");
  check(sourceDecode.ok, "imported source decodes completely", sourceDecode.errors.join(" | "));

  const expectedDuration = Number(process.env.S6_YOUTUBE_EXPECTED_DURATION || 0);
  if (expectedDuration > 0) {
    check(Math.abs(source.info.duration - expectedDuration) <= Math.max(5, expectedDuration * 0.02),
      "imported source duration matches the public metadata",
      `${source.info.duration.toFixed(2)}s vs ${expectedDuration}s`);
  }
  await extractFrames(source.path, join(root, "imported-source", "frames"), { label: "SRC" });

  const context = {
    aspect: "9:16", sourcePath: source.path, sourceInfo: source.info, sourceSha,
  };
  const results = {};
  results.smart = await verifyManifest("smart", {
    ...context, mode: "smart", expectCaptions: true, outputDir: join(root, "smart"),
  });
  results.fast = await verifyManifest("fast", {
    ...context, mode: "fast", expectCaptions: false, outputDir: join(root, "fast"),
  });
  // Fast mode with captions enabled transcribes only its selected windows, so
  // it proves burned-in captions on the imported source a second, cheaper way.
  results.fastCaptions = await verifyManifest("fast-captions", {
    ...context, mode: "fast-captions", expectCaptions: true, outputDir: join(root, "fast-captions"),
  });
  // Smart mode planned locally after a runtime OpenRouter failure. Written by
  // scripts/qa/youtube-openrouter-fallback.mjs, which points S6_YOUTUBE_ROOT at
  // its own artifact tree; absent (and skipped) in the ordinary import run.
  results.openrouterFallback = await verifyManifest("openrouter-fallback", {
    ...context, mode: "or-fallback", expectCaptions: true, outputDir: join(root, "openrouter-fallback"),
  });

  // No output may duplicate another mode's output.
  const everySha = Object.values(results).filter(Boolean).flatMap((mode) => mode.clips.map((clip) => clip.sha256));
  check(new Set(everySha).size === everySha.length, "every output across modes is distinct",
    `${new Set(everySha).size} distinct of ${everySha.length}`);

  const summary = {
    generatedAt: new Date().toISOString(),
    importedSource: {
      file: basename(source.path), sha256: sourceSha,
      width: source.info.video.width, height: source.info.video.height,
      videoCodec: source.info.video.codec, audioCodec: source.info.audio?.codec || null,
      frameRate: source.info.video.frameRate, duration: source.info.duration,
      sizeBytes: source.info.sizeBytes, streamCount: source.info.streamCount,
      decode: sourceDecode,
    },
    limits: LIMITS, modes: Object.fromEntries(Object.entries(results).filter(([, value]) => value)),
    failures, warnings,
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "content-validation.json"), JSON.stringify(summary, null, 2));

  console.log("\n=== YOUTUBE CONTENT VALIDATION ===");
  for (const [mode, value] of Object.entries(results)) {
    if (!value) { console.log(`${mode.padEnd(6)} (not run)`); continue; }
    console.log(`${mode.padEnd(6)} requested=${value.requestedCount} actual=${value.actualCount}`);
    for (const clip of value.clips) {
      const p = clip.probe; const v = clip.visual; const a = clip.audio || {};
      console.log(`  clip ${clip.index}: ${p.video.width}x${p.video.height} ${p.video.codec}/${p.audio?.codec || "none"} `
        + `${p.duration.toFixed(2)}s ${(clip.sizeBytes / 1024).toFixed(0)}KB decode=${clip.decode.ok ? "clean" : "CORRUPT"} `
        + `motion=${v.meanFrameDifference.toFixed(1)} local=${(v.maxTileMovingSampleFraction * 100).toFixed(0)}% `
        + `fullyFrozen=${v.longestLocallyFrozenSeconds.toFixed(1)}s `
        + `black=${(v.fractionOfFramesNearlyBlack * 100).toFixed(0)}% audio=${a.meanVolumeDb ?? "n/a"}dB`
        + (clip.captions ? ` captions=${(clip.captions.inkFraction * 100).toFixed(0)}%/${clip.captions.distinctBandStates}st` : "")
        + (clip.correspondence ? ` src=${clip.correspondence.claimed.meanColourDistance.toFixed(1)} decoy=${clip.correspondence.decoy.meanColourDistance.toFixed(1)}` : ""));
      if (clip.correspondence) {
        console.log(`            range ${clip.correspondence.claimed.sourceStart.toFixed(1)}-${clip.correspondence.claimed.sourceEnd.toFixed(1)}s of source`);
      }
    }
  }
  if (warnings.length) {
    console.log("\nWARNINGS:");
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const failure of failures) console.log(`  ✗ ${failure.message}${failure.detail ? ` — ${failure.detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll YouTube content validation checks passed.");
  }
}

await main();
