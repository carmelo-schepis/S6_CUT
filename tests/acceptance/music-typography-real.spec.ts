/** Real HTTP/worker/FFmpeg test for Music typography, lyric motion and the white hook banner.
 * Only ASR timestamps are a controlled fixture (deterministic timed words, not Whisper proof);
 * API responses, persistence, renders, restart recovery, caption edits, playback and ZIP
 * exports are real. Run with scripts/qa/verify-music-typography.mjs. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPlayback, checkPlayback, zipEntry } from './support/workspace';

const fixtures = process.env.S6_SOUNDTRACK_FIXTURES;
const container = process.env.S6_SOUNDTRACK_CONTAINER;
const HOOK = 'Hook banner text for the real typography integration run';
const WIDTH = 1080, HEIGHT = 1920;
// silent.mp4 is a 16:9 fixture on a 1080x1920 canvas: the fitted footage starts at y=570 (see _music_layout_geometry).
const FOOTAGE_TOP = 570;

type Words = { text: string; start: number; end: number }[];

function rgbFrame(filename: string, seconds: number): Buffer {
  return execFileSync('docker', ['exec', container!, 'ffmpeg', '-v', 'error', '-ss', String(seconds), '-i', `/qa/${filename}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
}
function pngFrame(filename: string, seconds: number): Buffer {
  return execFileSync('docker', ['exec', container!, 'ffmpeg', '-v', 'error', '-ss', String(seconds), '-i', `/qa/${filename}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 16 * 1024 * 1024 });
}
const pixel = (frame: Buffer, x: number, y: number) => { const offset = (y * WIDTH + x) * 3; return [frame[offset], frame[offset + 1], frame[offset + 2]]; };
const isWhite = (rgb: number[]) => rgb.every(channel => channel > 240);
/** Pixels in the lyric band that differ from the navy fixture footage (0,0,128). */
function textPixels(frame: Buffer, y0 = 860, y1 = 1060) {
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(frame, x, y);
    if (Math.abs(r) + Math.abs(g) + Math.abs(b - 128) > 120) count++;
  }
  return count;
}
function stripRows(frame: Buffer) {
  if (!isWhite(pixel(frame, 3, FOOTAGE_TOP - 1))) return null;
  let top = FOOTAGE_TOP - 1;
  while (top > 0 && isWhite(pixel(frame, 3, top - 1))) top--;
  return { top, bottom: FOOTAGE_TOP };
}
function verifyBanner(filename: string, seconds: number) {
  const sample = rgbFrame(filename, seconds);
  const strip = stripRows(sample);
  expect(strip, `white banner at ${seconds}s`).not.toBeNull();
  expect(strip!.bottom - strip!.top).toBeGreaterThanOrEqual(80);
  expect(isWhite(pixel(sample, WIDTH - 4, strip!.top + 5))).toBe(true);
  expect(pixel(sample, 3, Math.max(0, strip!.top - 5))[0]).toBeLessThan(30);
  const text = darkTextBounds(sample, strip!.top, strip!.bottom);
  expect(text.count).toBeGreaterThan(400);
  expect(Math.abs((text.minX + text.maxX) / 2 - WIDTH / 2)).toBeLessThan(WIDTH * .06);
  return sample;
}
function darkTextBounds(frame: Buffer, top: number, bottom: number) {
  let minX = WIDTH, maxX = 0, minY = HEIGHT, maxY = 0, count = 0;
  for (let y = top; y < bottom; y++) for (let x = 0; x < WIDTH; x++) {
    const [r, g, b] = pixel(frame, x, y);
    if (r + g + b < 300) { count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return { count, minX, maxX, minY, maxY };
}
function verifySongTone(filename: string, frequency: number) {
  const raw = execFileSync('docker', ['exec', container!, 'ffmpeg', '-v', 'error', '-ss', '0.2', '-i', `/qa/${filename}`, '-t', '1', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
  let crossings = 0, power = 0, previous = 0;
  for (let offset = 0; offset < raw.length; offset += 4) {
    const value = raw.readFloatLE(offset);
    if (previous <= 0 && value > 0) crossings++;
    power += value * value;
    previous = value;
  }
  const count = raw.length / 4;
  expect(Math.sqrt(power / count)).toBeGreaterThan(.02);
  expect(Math.abs(crossings / (count / 16000) - frequency)).toBeLessThan(25);
}
const sha256 = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('real attributed Music job keeps typography, banner, audio and saved captions through restart, repair rerender and export', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Use the isolated verification harness (scripts/qa/verify-music-typography.mjs)');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'iOS provides a read-only status view');
  test.setTimeout(900_000);
  const words: Words = JSON.parse(await fs.readFile(path.join(fixtures!, 'words.json'), 'utf8'));
  const name = `Typography ${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
  await page.getByRole('tab', { name: 'YouTube' }).click();
  await page.getByLabel('YouTube URL').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.getByRole('button', { name: 'Music / sung vocals' }).click();
  while (Number(await page.locator('.count-control strong').textContent()) > 2) await page.getByRole('button', { name: 'Fewer clips' }).click();
  await page.getByLabel('Background song MP3').setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: await fs.readFile(path.join(fixtures!, 'short-song.mp3')) });
  await page.getByRole('group', { name: 'Lyrics subtitle theme' }).getByRole('button', { name: 'Condensed white', exact: true }).click();
  await page.getByRole('group', { name: 'Lyric animation' }).getByRole('button', { name: 'Word build', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hook text' }).check();
  await page.getByRole('textbox', { name: 'Top text' }).fill(HOOK);
  await page.getByRole('group', { name: 'Hook text format' }).getByRole('button', { name: 'White banner', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await page.getByLabel('Minimum seconds').fill('8');
  await page.getByLabel('Maximum seconds').fill('10');
  await page.getByLabel('Project name').fill(name);
  const creation = page.waitForResponse(response => response.url().endsWith('/api/v1/jobs/clip') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create 2 short clips', exact: true }).click();
  const created = await creation;
  expect(created.status(), await created.text()).toBe(202);
  const { job: queued } = await created.json();
  expect(queued.musicPresentation).toEqual({ version: 1, subtitleTheme: 'condensed_white', lyricAnimation: 'word_build', hookTextFormat: 'white_banner' });
  expect(queued.musicTopText).toBe(HOOK);

  const readJob = async () => { const response = await request.get(`/api/v1/jobs/${queued.id}`); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); };
  const terminalSteps = (value: { steps: { status: string }[] }) => value.steps.every(step => ['complete', 'skipped'].includes(step.status));
  await expect.poll(async () => {
    const latest = await readJob();
    if (['failed', 'partial', 'stalled', 'cancelled_kept'].includes(latest.state)) throw new Error(JSON.stringify(latest));
    return latest.state === 'complete' && terminalSteps(latest);
  }, { timeout: 300_000, intervals: [500, 1000] }).toBe(true);
  let finished = await readJob();
  expect(finished.clips).toHaveLength(2);
  expect(finished.clips.map((value: { musicTreatment: string }) => value.musicTreatment).sort()).toEqual(["color", "grayscale"]);
  expect(finished.musicPresentation).toEqual(queued.musicPresentation);
  expect(finished.clips[0].creatorCredit).toBe('Source: Controlled Creator');
  const project = await (await request.get(`/api/v1/projects/${queued.projectId}`)).json();
  expect(project.sourceTitle).toBe('Controlled Music source');
  expect(project.sourceCreator).toBe('Controlled Creator');
  const attribution = JSON.parse(execFileSync('docker', ['exec', container!, 'python', '-c', 'from engine.app import db; import json,sys; p=db.get_job_private(sys.argv[1]); print(json.dumps({k:p.get(k) for k in ("url","youtube_title","youtube_creator")}))', queued.id]).toString());
  expect(attribution).toMatchObject({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', youtube_title: 'Controlled Music source', youtube_creator: 'Controlled Creator' });
  await expect(page.locator('.clip-tile.complete')).toHaveCount(2);
  await page.locator('.clip-tile.complete').first().getByRole('button', { name: 'Preview', exact: true }).click();
  checkPlayback(await assertPlayback(page), name);

  // --- rendered pixels: banner strip, then word-by-word build ---
  let clip = finished.clips.find((value: { musicTreatment: string }) => value.musicTreatment === 'color')!;
  const original = (await request.get(clip.downloadUrl));
  expect(original.ok()).toBeTruthy();
  const originalBytes = await original.body();
  await fs.writeFile(path.join(fixtures!, 'typography.mp4'), originalBytes);
  // Inspect encoded downloads from both balanced treatments. These edge pixels
  // sit in the top and bottom black padding, clear of centered titles and lyrics.
  const blackPaddingPoints = [[4, 30], [1076, 30], [4, 100], [1076, 100], [4, 1400], [1076, 1400], [4, 1800], [1076, 1800]];
  for (const treatmentClip of finished.clips) {
    const treatment = treatmentClip.musicTreatment as "color" | "grayscale";
    const filename = `typography-${treatment}.mp4`;
    const downloaded = treatmentClip.id === clip.id ? originalBytes : Buffer.from(await (await request.get(treatmentClip.downloadUrl)).body());
    await fs.writeFile(path.join(fixtures!, filename), downloaded);
    const times = [...new Set([1.0, Math.min(treatmentClip.duration - 0.5, treatmentClip.duration / 2)])];
    for (const time of times) {
      const frame = rgbFrame(filename, time);
      const observed = blackPaddingPoints.map(([x, y]) => ({ point: [x, y], rgb: pixel(frame, x, y) }));
      console.log(`letterbox black pixels treatment=${treatment} time=${time}s ${JSON.stringify(observed)}`);
      for (const sample of observed) expect(Math.max(...sample.rgb), `${treatment} letterbox ${sample.point.join(",")} at ${time}s RGB ${sample.rgb}`).toBeLessThanOrEqual(4);
    }
  }
  const first = words.find(word => word.end > clip.start)!;
  const onset = Math.max(0, first.start - clip.start);
  const sampleMoments = [1.0, ...(clip.duration > 9.2 ? [9.2] : []), ...(clip.duration > 12 ? [12.0] : []), ...(clip.duration > 20.2 ? [20.0] : [])];
  const probe = verifyBanner('typography.mp4', 1.0);
  for (const moment of sampleMoments.slice(1)) verifyBanner('typography.mp4', moment);
  for (const moment of sampleMoments) {
    const png = pngFrame('typography.mp4', moment);
    await fs.writeFile(path.join(fixtures!, `banner-${moment}s.png`), png);
    await testInfo.attach(`banner-${moment}s`, { body: png, contentType: 'image/png' });
  }
  const initialStrip = stripRows(probe)!;
  const text = darkTextBounds(probe, initialStrip.top, initialStrip.bottom);
  expect(text.count).toBeGreaterThan(400);
  expect(text.minY - initialStrip.top).toBeGreaterThanOrEqual(4);
  expect(initialStrip.bottom - 1 - text.maxY).toBeGreaterThanOrEqual(4);
  expect(Math.abs((text.minX + text.maxX) / 2 - WIDTH / 2)).toBeLessThan(WIDTH * .06);
  // Word build: nothing before the first word, then a growing set of words.
  if (onset > .15) expect(textPixels(rgbFrame('typography.mp4', onset - .1))).toBe(0);
  const early = textPixels(rgbFrame('typography.mp4', onset + .45));
  const later = Math.max(...[1.4, 2.4, 3.4].map(offset => textPixels(rgbFrame('typography.mp4', onset + offset))));
  expect(early).toBeGreaterThan(150);
  expect(later).toBeGreaterThan(early * 1.4);
  verifySongTone('typography.mp4', 660);
  await fs.writeFile(path.join(fixtures!, 'typography-frame-original.rgb'), rgbFrame('typography.mp4', onset + 1.6));

  // --- retention + restart, then rerender the exact saved captions and options ---
  execFileSync('docker', ['exec', container!, 'python', '-c', 'import shutil,sys; shutil.rmtree("/app/data/jobs/"+sys.argv[1])', queued.id]);
  execFileSync('docker', ['restart', '--timeout=1', container!]);
  await expect.poll(async () => { try { return (await request.get('/api/v1/health')).status(); } catch { return 0; } }, { timeout: 300_000 }).toBe(200);
  const savedCues = clip.captionCues;
  expect(savedCues.length).toBeGreaterThan(0);
  const edited = await request.put(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions`, { data: { revision: clip.captionRevision, cues: savedCues } });
  expect(edited.ok(), await edited.text()).toBeTruthy();
  const editedJob = await edited.json();
  const revision = editedJob.clips.find((value: { id: string }) => value.id === clip.id).captionRevision;
  const render = await request.post(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions/rerender?revision=${revision}`);
  expect(render.ok(), await render.text()).toBeTruthy();
  await expect.poll(async () => {
    const latest = await readJob();
    const latestClip = latest.clips.find((value: { id: string }) => value.id === clip.id);
    return latest.state === 'complete' && terminalSteps(latest) && latestClip.captionRevision === revision
      && latestClip.creatorCredit === 'Source: Controlled Creator';
  }, { timeout: 300_000, intervals: [500, 1000] }).toBe(true);
  finished = await readJob();
  expect(finished.warnings.some((warning: string) => warning.includes('Caption rerender failed'))).toBe(false);
  expect(finished.musicPresentation).toEqual(queued.musicPresentation);
  expect(finished.clips.find((value: { id: string }) => value.id === clip.id).libraryAssetId).toBe(clip.libraryAssetId);
  expect(finished.clips.find((value: { id: string }) => value.id === clip.id).captionCues).toEqual(savedCues);
  clip = finished.clips.find((value: { id: string }) => value.id === clip.id)!;
  const revised = Buffer.from(await (await request.get(clip.downloadUrl)).body());
  await fs.writeFile(path.join(fixtures!, 'typography-reviewed.mp4'), revised);
  for (const moment of sampleMoments) verifyBanner('typography-reviewed.mp4', moment);
  expect(textPixels(rgbFrame('typography-reviewed.mp4', 1.6))).toBeGreaterThan(150);
  verifySongTone('typography-reviewed.mp4', 660);
  const sidecar = (name: string) => clip.captionDownloads.find((value: { format: string }) => value.format === name);
  const ass = await (await request.get(sidecar('ass').url)).text();
  expect(ass).toContain('Style: Caption,Oswald,');
  expect(ass).toMatch(/\\t\(\d+,\d+,\\1a&H00&/);
  expect(ass).toContain(savedCues[0].text);
  expect(await (await request.get(sidecar('srt').url)).text()).toContain(savedCues[0].text);

  // --- ZIP: same published MP4, additive metadata ---
  await page.reload();
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.locator(`.job-card[data-job-id="${queued.id}"]`).getByRole('button', { name: 'Open', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download ZIP/ }).click();
  const archive = path.join(fixtures!, 'typography-export.zip');
  await (await downloadPromise).saveAs(archive);
  const manifest = JSON.parse(zipEntry(archive, `${name}/manifest.json`));
  expect(manifest.outputs[0].music_presentation).toEqual({ subtitle_theme: 'condensed_white', lyric_animation: 'word_build', hook_text_format: 'white_banner' });
  expect(manifest.outputs[0].music_top_text).toBe(HOOK);
  const zippedMp4 = execFileSync('python3', ['-I', '-c', 'import hashlib,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(",".join(hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith(".mp4")))', archive]).toString().trim().split(',');
  expect(zippedMp4).toContain(sha256(revised));
  const zippedBytes = execFileSync('python3', ['-I', '-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1]); n=next(n for n in z.namelist() if n.endswith(".mp4")); sys.stdout.buffer.write(z.read(n))', archive], { maxBuffer: 256 * 1024 * 1024 });
  await fs.writeFile(path.join(fixtures!, 'typography-zipped.mp4'), zippedBytes);
  for (const moment of sampleMoments) verifyBanner('typography-zipped.mp4', moment);
  await testInfo.attach('persisted-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
});
