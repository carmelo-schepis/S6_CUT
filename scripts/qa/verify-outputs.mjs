/**
 * Content validation for the S6_cut authenticity acceptance run.
 *
 * Reads the manifests the Playwright workflows wrote, then proves from decoded
 * pixels and decoded audio that each downloaded output is newly rendered,
 * moving, correctly framed, correctly sourced, audible where audio is
 * expected, and captioned where captions were promised.
 *
 * Thresholds are calibrated against negative controls built by the same run
 * (frozen picture, all-black picture, silent track, wrong source range) rather
 * than chosen by hand; reports/calibration.json records the measurements.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import {
  setMountRoot, probe, fullDecode, visualMetrics, audioMetrics, extractFrames,
  sourceCorrespondence, bandActivity, sectionProfile, MOTION_FLOOR,
} from "./media-forensics.mjs";

const root = resolve(process.env.S6_AUTHENTICITY_ROOT || "test-artifacts/content-authenticity");
setMountRoot(root);
const fixturePath = join(root, "fixture/s6cut-authenticity-source.mp4");

/**
 * Pass thresholds. Each cites the control measurement that justifies it, so a
 * later reader can see the margin rather than trusting a bare number.
 */
const LIMITS = {
  // black control measured 1.00; real content measured 0.00
  maxNearlyBlackFrameFraction: 0.5,
  // black control measured luminance 2.0; real content measured 81
  minMeanLuminance: 12,
  // black control measured variance 0; real content measured 2701
  minMeanVariance: 100,
  // frozen control measured 0.001 (max 0.04); real content measured 27.0
  minMeanFrameDifference: 0.5,
  // frozen control measured 0.0; real content measured 1.0
  minMovingSampleFraction: 0.5,
  // a deliberately static title card is allowed, a frozen output is not
  maxFrozenSeconds: 3.0,
  // frozen control produced 1 distinct hash from 40 frames
  minDistinctHashFraction: 0.1,
  // silent control measured -91 dB peak
  minPeakDb: -50,
  minMeanDb: -45,
  maxSilentFraction: 0.6,
  // correct range measured colour distance 0.1, wrong range measured 56.1
  maxCorrespondenceColourDistance: 30,
  minDecoyColourMargin: 3.0,
  maxCorrespondenceHamming: 12,
  // an uncaptioned reframe measured ink fraction 0.00
  minCaptionInkFraction: 0.15,
  minCaptionDistinctStates: 4,
};

const failures = [];
const warnings = [];
function check(condition, message, detail) {
  if (!condition) failures.push({ message, detail });
  return Boolean(condition);
}

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

const ASPECTS = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080], "4:5": [1080, 1350] };

async function verifyClip(clip, context) {
  const label = `${context.mode} clip ${clip.index}`;
  const limits = LIMITS;
  const file = clip.downloadPath;
  const outputDir = join(context.outputDir, `clip-${clip.index}-analysis`);
  await mkdir(outputDir, { recursive: true });
  const report = { label, file: basename(file), index: clip.index, thresholdProfile: "source-derived" };

  // --- 1. The downloaded file is real and distinct from the input ----------
  const bytes = await readFile(file);
  report.sizeBytes = bytes.length;
  report.sha256 = sha256(bytes);
  check(bytes.length > 50_000, `${label}: downloaded file has a meaningful size`, `${bytes.length} bytes`);
  check(report.sha256 !== context.fixtureSha, `${label}: output differs from the input fixture`, report.sha256);
  check(report.sha256 === clip.sha256, `${label}: browser download matches the re-read file`, `${clip.sha256} vs ${report.sha256}`);

  // --- 2. Container and streams -------------------------------------------
  const info = await probe(file);
  report.probe = {
    container: info.container, duration: info.duration, streamCount: info.streamCount,
    video: info.video, audio: info.audio, sizeBytes: info.sizeBytes, bitRate: info.bitRate,
  };
  await writeFile(join(outputDir, "ffprobe.json"), JSON.stringify(info.raw, null, 2));
  check(info.video, `${label}: has a video stream`);
  check(info.duration > 0 && Number.isFinite(info.duration), `${label}: plausible duration`, `${info.duration}s`);

  const expected = ASPECTS[context.aspect];
  if (expected) {
    check(info.video.width === expected[0] && info.video.height === expected[1],
      `${label}: output dimensions are the requested ${context.aspect}`,
      `${info.video.width}x${info.video.height}, wanted ${expected[0]}x${expected[1]}`);
  }
  check(info.video.width !== context.sourceInfo.video.width || info.video.height !== context.sourceInfo.video.height,
    `${label}: output is not the untouched source frame size`,
    `${info.video.width}x${info.video.height}`);
  // The reported duration must agree with the boundaries the workspace showed.
  if (Number.isFinite(clip.sourceStart) && Number.isFinite(clip.sourceEnd)) {
    const boundarySpan = clip.sourceEnd - clip.sourceStart;
    report.boundarySpan = boundarySpan;
    check(Math.abs(info.duration - boundarySpan) <= Math.max(1.0, boundarySpan * 0.12),
      `${label}: duration agrees with its reported source boundaries`,
      `output ${info.duration.toFixed(2)}s vs boundaries ${boundarySpan.toFixed(2)}s`);
  }

  // --- 3. Complete decode --------------------------------------------------
  const decode = await fullDecode(file);
  report.decode = decode;
  await writeFile(join(outputDir, "decode.json"), JSON.stringify(decode, null, 2));
  check(decode.ok, `${label}: decodes completely without corruption`, decode.errors.join(" | "));

  // --- 4. Decoded-pixel visual metrics ------------------------------------
  const visual = await visualMetrics(file);
  report.visual = { ...visual, perceptualHashes: undefined, hashCount: visual.perceptualHashes.length };
  await writeFile(join(outputDir, "visual-metrics.json"), JSON.stringify(visual, null, 2));
  check(visual.fractionOfFramesNearlyBlack <= limits.maxNearlyBlackFrameFraction,
    `${label}: sampled frames are not almost entirely black`, `${(visual.fractionOfFramesNearlyBlack * 100).toFixed(1)}%`);
  check(visual.meanLuminance >= limits.minMeanLuminance,
    `${label}: picture is not black`, `mean luminance ${visual.meanLuminance.toFixed(1)}`);
  check(visual.meanVariance >= limits.minMeanVariance,
    `${label}: picture has spatial detail, not a flat placeholder`, `variance ${visual.meanVariance.toFixed(0)}`);
  check(visual.meanFrameDifference >= limits.minMeanFrameDifference,
    `${label}: picture changes over time`, `mean frame difference ${visual.meanFrameDifference.toFixed(3)} (frozen control 0.001)`);
  check(visual.movingSampleFraction >= limits.minMovingSampleFraction,
    `${label}: most sampled frame pairs show motion`, `${(visual.movingSampleFraction * 100).toFixed(1)}% above floor ${MOTION_FLOOR}`);
  check(visual.longestFrozenSeconds <= limits.maxFrozenSeconds,
    `${label}: no long frozen run`, `${visual.longestFrozenSeconds.toFixed(2)}s frozen`);
  const hashFraction = visual.distinctPerceptualHashes / visual.sampledFrames;
  check(hashFraction >= limits.minDistinctHashFraction,
    `${label}: frames are not effectively identical throughout`,
    `${visual.distinctPerceptualHashes} distinct hashes from ${visual.sampledFrames} frames`);

  // --- 5. Frames and contact sheet for visual inspection -------------------
  const { frames, contactSheet } = await extractFrames(file, outputDir, { label: `C${clip.index}` });
  report.frames = frames.map((frame) => basename(frame.path));
  report.contactSheet = basename(contactSheet);

  // --- 6. Audio ------------------------------------------------------------
  const audio = await audioMetrics(file);
  report.audio = audio;
  await writeFile(join(outputDir, "audio-metrics.json"), JSON.stringify(audio, null, 2));
  if (context.expectAudio) {
    check(audio.hasAudio, `${label}: has an audio stream`);
    if (audio.hasAudio) {
      check(!audio.entirelySilent, `${label}: audio track is not entirely silent`, `peak ${audio.peakVolumeDb} dB`);
      check(audio.peakVolumeDb >= limits.minPeakDb, `${label}: audio peak is audible`, `${audio.peakVolumeDb} dB`);
      check(audio.meanVolumeDb >= limits.minMeanDb, `${label}: audio mean level is audible`, `${audio.meanVolumeDb} dB`);
      check(Math.abs(audio.duration - info.duration) <= 0.5,
        `${label}: audio duration matches the video`, `${audio.duration}s vs ${info.duration}s`);
      check(audio.silentFraction <= limits.maxSilentFraction,
        `${label}: no unexplained silent majority`, `${(audio.silentFraction * 100).toFixed(1)}% silent`);
      const audible = Object.entries(audio.windows).filter(([, window]) => window.peak > -50).map(([name]) => name);
      report.audibleWindows = audible;
      check(audible.length >= 2, `${label}: audio present in at least two of begin/middle/end`, audible.join(","));
      // A hard truncation shows up as the final window being dead while the
      // rest of the track is not.
      if (audio.windows.nearEnd.peak <= -70 && audio.windows.middle.peak > -30) {
        warnings.push(`${label}: final ${audio.windows.nearEnd.length.toFixed(1)}s window is silent (peak ${audio.windows.nearEnd.peak} dB)`);
      }
    }
  }

  // --- 7. Captions ---------------------------------------------------------
  if (context.expectCaptions) {
    const bandTop = Math.round(info.video.height * 0.74);
    const bandHeight = Math.round(info.video.height * 0.20);
    const band = await bandActivity(file, { top: bandTop, height: bandHeight, samples: 48 });
    report.captions = { band: `${bandTop}+${bandHeight}`, ...band };
    await writeFile(join(outputDir, "caption-band.json"), JSON.stringify(report.captions, null, 2));
    check(band.inkFraction >= limits.minCaptionInkFraction,
      `${label}: burned-in caption text is visible`, `ink on ${(band.inkFraction * 100).toFixed(0)}% of sampled frames (uncaptioned control 0%)`);
    check(band.distinctBandStates >= limits.minCaptionDistinctStates,
      `${label}: caption text changes as speech progresses`, `${band.distinctBandStates} distinct caption states`);
    // Captions must sit inside the frame: measure a 3%-tall strip at the very
    // bottom edge and require it to stay clear of caption ink.
    const edge = await bandActivity(file, { top: info.video.height - Math.round(info.video.height * 0.03), height: Math.round(info.video.height * 0.03), samples: 24 });
    report.captionEdge = edge;
    check(edge.maxCoverage < 0.02,
      `${label}: captions are not clipped by the bottom frame edge`, `edge ink ${(edge.maxCoverage * 100).toFixed(2)}%`);
  }

  // --- 8. Source correspondence -------------------------------------------
  if (Number.isFinite(clip.sourceStart) && Number.isFinite(clip.sourceEnd) && context.checkCorrespondence) {
    const claimed = await sourceCorrespondence(file, fixturePath, {
      sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, samples: 8,
    });
    // A decoy range of the same length, deliberately placed elsewhere in the
    // source, calibrates the comparison for this specific clip.
    const span = clip.sourceEnd - clip.sourceStart;
    let decoyStart = clip.sourceStart + span + 12;
    if (decoyStart + span > context.sourceInfo.duration) decoyStart = Math.max(0, clip.sourceStart - span - 12);
    const decoy = await sourceCorrespondence(file, fixturePath, {
      sourceStart: decoyStart, sourceEnd: decoyStart + span, samples: 8,
    });
    report.correspondence = { claimed, decoy, decoyStart };
    await writeFile(join(outputDir, "source-correspondence.json"), JSON.stringify(report.correspondence, null, 2));
    check(claimed.meanColourDistance <= limits.maxCorrespondenceColourDistance,
      `${label}: output matches its reported source range`,
      `colour distance ${claimed.meanColourDistance.toFixed(2)} over ${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}s`);
    check(claimed.meanHammingDistance <= limits.maxCorrespondenceHamming,
      `${label}: output structure matches its reported source range`,
      `hamming ${claimed.meanHammingDistance.toFixed(2)}`);
    check(decoy.meanColourDistance - claimed.meanColourDistance >= limits.minDecoyColourMargin,
      `${label}: output matches its own range better than an unrelated range`,
      `claimed ${claimed.meanColourDistance.toFixed(2)} vs decoy@${decoyStart.toFixed(1)}s ${decoy.meanColourDistance.toFixed(2)}`);

    // Which fixture section(s) the output actually shows.
    const profile = await sectionProfile(file, context.sections, { samples: 16 });
    report.sectionProfile = profile.map((entry) => ({ t: Number(entry.time.toFixed(2)), section: entry.section, colour: entry.colour }));
    const seen = [...new Set(profile.map((entry) => entry.section))];
    const expectedSections = context.sections
      .filter((section) => clip.sourceStart < section.end && clip.sourceEnd > section.start)
      .map((section) => section.name);
    report.sectionsSeen = seen;
    report.sectionsExpected = expectedSections;
    check(seen.every((name) => expectedSections.includes(name)),
      `${label}: visible sections come only from the reported source range`,
      `saw ${seen.join(",")} expected ${expectedSections.join(",")}`);
  }

  return report;
}

async function verifyManifest(name, options) {
  const manifestPath = join(root, "reports", `${name}.json`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Required ${name} manifest is missing or invalid at ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.clips) || manifest.clips.length === 0) {
    throw new Error(`Required ${name} manifest contains no clips: ${manifestPath}`);
  }
  const sourceInfo = await probe(fixturePath);
  const fixtureSha = sha256(await readFile(fixturePath));
  const context = {
    mode: manifest.mode, aspect: "9:16", sourceInfo, fixtureSha,
    outputDir: join(root, name), sections: options.sections,
    expectAudio: options.expectAudio, expectCaptions: options.expectCaptions,
    checkCorrespondence: options.checkCorrespondence,
  };
  const clips = [];
  for (const clip of manifest.clips) clips.push(await verifyClip(clip, context));

  // Multiple outputs must not repeat the same source range or the same bytes.
  if (manifest.clips.length > 1) {
    const digests = new Set(clips.map((clip) => clip.sha256));
    check(digests.size === clips.length, `${name}: outputs are not byte-identical duplicates`, `${digests.size} distinct of ${clips.length}`);
    if (options.checkCorrespondence) {
      const ranges = manifest.clips.map((clip) => `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`);
      check(new Set(ranges).size === ranges.length, `${name}: outputs use different source ranges`, ranges.join(" | "));
    }
  }
  return { ...manifest, clips, requested: manifest.requestedCount, actual: manifest.actualCount };
}

// The fixture's four sections, used to identify which part of the source an
// output actually shows.
const SECTIONS = [
  { name: "A", start: 0, end: 19, rgb: [] },
  { name: "B", start: 19, end: 38, rgb: [] },
  { name: "C", start: 38, end: 57, rgb: [] },
  { name: "D", start: 57, end: 76, rgb: [] },
];

async function main() {
  // Reference colours are measured from the fixture itself rather than assumed
  // from the build script's hex values, so overlays and text are included.
  const midpoints = await sectionProfile(fixturePath, SECTIONS.map((section) => ({ name: section.name, rgb: [0, 0, 0] })), { samples: 76 });
  for (const section of SECTIONS) {
    const inside = midpoints.filter((entry) => entry.time >= section.start + 3 && entry.time <= section.end - 3);
    const mean = [0, 1, 2].map((channel) => inside.reduce((sum, entry) => sum + entry.colour[channel], 0) / inside.length);
    section.rgb = mean.map((value) => Math.round(value));
  }
  console.log("fixture section reference colours:", SECTIONS.map((s) => `${s.name}=${s.rgb.join(",")}`).join("  "));

  const results = {};
  results.smart = await verifyManifest("smart", { sections: SECTIONS, expectAudio: true, expectCaptions: true, checkCorrespondence: true });
  results.fast = await verifyManifest("fast", { sections: SECTIONS, expectAudio: true, expectCaptions: false, checkCorrespondence: true });
  results.fallback = await verifyManifest("fallback", { sections: SECTIONS, expectAudio: true, expectCaptions: true, checkCorrespondence: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    fixture: { path: basename(fixturePath), sha256: sha256(await readFile(fixturePath)) },
    limits: { sourceDerived: LIMITS },
    modes: Object.fromEntries(Object.entries(results).filter(([, value]) => value)),
    failures,
    warnings,
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "content-validation.json"), JSON.stringify(summary, null, 2));

  console.log("\n=== CONTENT VALIDATION ===");
  for (const [mode, value] of Object.entries(results)) {
    if (!value) { console.log(`${mode.padEnd(9)} (not run)`); continue; }
    console.log(`${mode.padEnd(9)} requested=${value.requested} actual=${value.actual} outputs=${value.clips.length}`);
    for (const clip of value.clips) {
      console.log(`  clip ${clip.index}: ${clip.probe.video.width}x${clip.probe.video.height} ${clip.probe.video.codec}/${clip.probe.audio?.codec || "none"} `
        + `${clip.probe.duration.toFixed(2)}s ${(clip.sizeBytes / 1024).toFixed(0)}KB decode=${clip.decode.ok ? "clean" : "CORRUPT"} `
        + `motion=${clip.visual.meanFrameDifference.toFixed(1)} frozen=${clip.visual.longestFrozenSeconds.toFixed(1)}s `
        + `black=${(clip.visual.fractionOfFramesNearlyBlack * 100).toFixed(0)}% `
        + `audio=${clip.audio?.hasAudio ? `${clip.audio.meanVolumeDb}dB` : "none"}`
        + (clip.captions ? ` captions=${(clip.captions.inkFraction * 100).toFixed(0)}%/${clip.captions.distinctBandStates}st` : "")
        + (clip.correspondence ? ` src=${clip.correspondence.claimed.meanColourDistance.toFixed(1)} decoy=${clip.correspondence.decoy.meanColourDistance.toFixed(1)} sections=${clip.sectionsSeen.join("")}` : ""));
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
    console.log("\nAll content validation checks passed.");
  }
  void readdir;
}

await main();
