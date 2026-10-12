#!/usr/bin/env node
/** Verify downloaded AI-hook acceptance MP4s with FFprobe from the engine image. */
import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const directory = path.resolve(process.argv[2] || "test-artifacts/ai-hook-text");
const image = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4") && !/timeout/i.test(entry.name))
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) throw new Error(`No downloaded MP4 media found in ${directory}`);

const results = [];
for (const file of files) {
  const probe = spawnSync("docker", ["run", "--rm", "--network", "none", "-v", `${directory}:/media:ro`,
    "--entrypoint", "ffprobe", image, "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height",
    "-of", "json", `/media/${file}`], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`FFprobe failed for ${file}: ${probe.stderr.trim()}`);
  const metadata = JSON.parse(probe.stdout);
  const streams = metadata.streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(metadata.format?.duration);
  const sizeBytes = Number(metadata.format?.size);
  if (!video || !audio || !(duration > 0 && duration <= 180) || !(sizeBytes > 50_000)) {
    throw new Error(`${file} is not a valid short with audio/video: ${JSON.stringify({ duration, sizeBytes, video, audio })}`);
  }
  const sample = spawnSync("docker", ["run", "--rm", "--network", "none", "-v", `${directory}:/media:ro`,
    "--entrypoint", "ffmpeg", image, "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", `/media/${file}`,
    "-frames:v", "1", "-vf", "crop=iw:ih*0.25:0:0,scale=270:320", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  { maxBuffer: 2 * 1024 * 1024 });
  if (sample.status !== 0) throw new Error(`FFmpeg hook-frame sampling failed for ${file}: ${sample.stderr.toString().trim()}`);
  const brightTopPixels = Array.from({ length: Math.floor(sample.stdout.length / 3) }, (_, index) => index)
    .filter((index) => sample.stdout[index * 3] > 205 && sample.stdout[index * 3 + 1] > 205 && sample.stdout[index * 3 + 2] > 205).length;
  if (brightTopPixels < 20) throw new Error(`${file} has no visible bright hook text in the top safe area at 1s`);
  results.push({ file, duration, sizeBytes, width: video.width, height: video.height, hasAudio: true, hasVideo: true,
    sampleTimestampSeconds: 1, topBandBrightPixels: brightTopPixels });
}

const report = path.join(directory, "ffprobe-media-verification.json");
await writeFile(report, `${JSON.stringify({ verified: results.length, results }, null, 2)}\n`);
console.log(`Verified ${results.length} playable short-form media file(s); report: ${report}`);
