/** Real HTTP/worker/FFmpeg test. Only ASR timestamps and external yt-dlp transport
 * are controlled fixtures; API responses, persistence, renders, playback, caption
 * edits and ZIP exports are real. Run with scripts/qa/verify-music-soundtrack.mjs. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPlayback, checkPlayback, zipEntry } from './support/workspace';

const fixtures = process.env.S6_SOUNDTRACK_FIXTURES;
const container = process.env.S6_SOUNDTRACK_CONTAINER;
const cases: { source: string; speed: number; audioMode?: 'song_only' | 'mix_original'; silentVideo?: boolean }[] = [
  { source: 'upload', speed: 1 },
  { source: 'upload', speed: 1.5 },
  { source: 'upload', speed: 0.85 },
  { source: 'upload', speed: 1.25 },
  { source: 'youtube', speed: .75 },
  { source: 'none', speed: 1 },
  { source: 'none', speed: 1, audioMode: 'mix_original' as const },
  { source: 'upload', speed: 1, audioMode: 'mix_original' as const },
  { source: 'upload', speed: 1, audioMode: 'mix_original' as const, silentVideo: true },
];

function toneAmplitude(raw: Buffer, frequency: number) {
  const rate = 16000;
  const start = Math.floor(.15 * rate), end = Math.min(raw.length / 4, Math.floor(.95 * rate));
  let real = 0, imaginary = 0, windowTotal = 0;
  for (let index = start; index < end; index++) {
    const position = index - start;
    const window = .5 - .5 * Math.cos(2 * Math.PI * position / Math.max(1, end - start - 1));
    const value = raw.readFloatLE(index * 4) * window;
    const angle = 2 * Math.PI * frequency * index / rate;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
    windowTotal += window;
  }
  return 2 * Math.hypot(real, imaginary) / windowTotal;
}

function verifySongAtQuarterGain(filename: string) {
  const raw = execFileSync('docker', ['exec', container!, 'ffmpeg', '-v', 'error', '-i', `/qa/${filename}`, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
  expect(toneAmplitude(raw, 660)).toBeGreaterThan(.01);
  expect(toneAmplitude(raw, 660)).toBeLessThan(.08);
}

function verifyMix(filename: string) {
  const raw = execFileSync('docker', ['exec', container!, 'ffmpeg', '-v', 'error', '-i', `/qa/${filename}`, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
  const original = toneAmplitude(raw, 220), song = toneAmplitude(raw, 660);
  expect(original).toBeGreaterThan(.05);
  expect(song).toBeGreaterThan(.004);
  expect(song / original).toBeGreaterThan(.07);
  expect(song / original).toBeLessThan(.13);
}

function verifyAudio(filename: string, frequency: number) {
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

for (const item of cases) {
  test(`real soundtrack: ${item.source} at ${item.speed}x ${item.audioMode || 'song-only'}${item.silentVideo ? ' silent video' : ''}`, async ({ page, request }, testInfo) => {
    test.skip(!fixtures || !container, 'Use the isolated soundtrack verification harness');
    test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'iOS provides a read-only status view');
    test.setTimeout(900_000);
    const name = `Soundtrack ${item.source} ${item.speed} ${Date.now()}`;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
    const videoFixture = item.source === 'none' || (item.audioMode === 'mix_original' && !item.silentVideo) ? 'with-audio.mp4' : 'silent.mp4';
    await page.getByLabel('Choose video file').setInputFiles(path.join(fixtures!, videoFixture));
    await page.getByRole('button', { name: 'Music / sung vocals' }).click();
    while (Number(await page.locator('.count-control strong').textContent()) > 1) {
      await page.getByRole('button', { name: 'Fewer clips' }).click();
    }
    // The title deliberately matches a lyric: audio must never become a visual overlay.
    if (item.source === 'upload' || (item.source === 'none' && item.audioMode)) await page.getByLabel('Background song MP3').setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: await fs.readFile(path.join(fixtures!, 'short-song.mp3')) });
    if (item.source === 'youtube') await page.getByLabel('YouTube song URL').fill('https://music.youtube.com/watch?v=BaW_jenozKc');
    if (item.audioMode) {
      await page.getByRole('button', { name: 'Original audio + song' }).click();
      if (item.source === 'none') await page.getByRole('button', { name: 'Remove song' }).click();
    }
    await page.getByLabel('Song speed').selectOption(String(item.speed));
    await page.getByRole('button', { name: 'Advanced controls' }).click();
    await page.getByLabel('Minimum seconds').fill('8');
    await page.getByLabel('Maximum seconds').fill('10');
    await page.getByLabel('Project name').fill(name);
    if (item.audioMode === 'mix_original' && item.source !== 'none' && !item.silentVideo) await page.getByRole('slider', { name: 'Background song volume' }).fill('10');
    const creation = page.waitForResponse(response => response.url().endsWith('/api/v1/jobs/clip') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create 1 short clip', exact: true }).click();
    const created = await creation;
    expect(created.status(), await created.text()).toBe(202);
    const { job: queued } = await created.json();
    const readJob = async () => {
      const response = await request.get(`/api/v1/jobs/${queued.id}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const terminalSteps = (value: { steps: { status: string }[] }) => value.steps.every(step => ['complete', 'skipped'].includes(step.status));
    await expect.poll(async () => {
      const latest = await readJob();
      if (['failed', 'partial', 'stalled', 'cancelled_kept'].includes(latest.state)) throw new Error(JSON.stringify(latest));
      return latest.state === 'complete' && terminalSteps(latest);
    }, { timeout: 300_000, intervals: [500, 1000] }).toBe(true);
    let finished = await readJob();
    expect(finished.clips).toHaveLength(1);
    if (item.audioMode) expect(finished.musicAudioMode).toBe(item.audioMode);
    if (item.audioMode === 'mix_original' && item.source !== 'none' && !item.silentVideo) expect(finished.musicSongGain).toBe(.1);
    expect(finished.steps.every((step: { status: string }) => ['complete', 'skipped'].includes(step.status))).toBe(true);
    if (item.source === 'none') expect(finished.musicTrack).toBeNull();
    else expect(finished.musicTrack).toMatchObject({ source: item.source === 'upload' ? 'upload' : 'youtube', speed: item.speed });
    await expect(page.locator('.clip-tile.complete')).toHaveCount(1);
    await page.locator('.clip-tile.complete').getByRole('button', { name: 'Preview', exact: true }).click();
    checkPlayback(await assertPlayback(page), name);
    let clip = finished.clips[0];
    const filename = `output-${item.source}-${item.speed}-${item.audioMode || 'song-only'}.mp4`;
    const output = await request.get(clip.downloadUrl);
    expect(output.ok()).toBeTruthy();
    await fs.writeFile(path.join(fixtures!, filename), await output.body());
    if (item.source === 'none') verifyAudio(filename, 220);
    else if (item.audioMode === 'mix_original' && item.silentVideo) {
      verifySongAtQuarterGain(filename);
      expect(finished.warnings.some((warning: string) => warning.includes('Original audio was unavailable'))).toBe(true);
    } else if (item.audioMode === 'mix_original') verifyMix(filename);
    else verifyAudio(filename, item.source === 'none' ? 220 : 660 * item.speed);

    if (item.source === 'upload' && item.speed === 1 && !item.silentVideo) {
      // Retention and restart must leave both the original footage and song usable.
      execFileSync('docker', ['exec', container!, 'python', '-c', 'import shutil,sys; shutil.rmtree("/app/data/jobs/"+sys.argv[1])', queued.id]);
      execFileSync('docker', ['restart', '--timeout=1', container!]);
      await expect.poll(async () => {
        try { return (await request.get('/api/v1/health')).status(); } catch { return 0; }
      }, { timeout: 300_000 }).toBe(200);
      const edited = await request.put(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions`, { data: { revision: clip.captionRevision, cues: [{ id: 'review', start: 0, end: 1.5, text: 'Reviewed background song' }] } });
      expect(edited.ok(), await edited.text()).toBeTruthy();
      const revision = (await edited.json()).clips[0].captionRevision;
      const render = await request.post(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions/rerender?revision=${revision}`);
      expect(render.ok(), await render.text()).toBeTruthy();
      await expect.poll(async () => {
        const latest = await readJob();
        return latest.state === 'complete' && terminalSteps(latest) && latest.clips[0].blobId !== clip.blobId;
      }, { timeout: 300_000, intervals: [500, 1000] }).toBe(true);
      finished = await readJob();
      expect(finished.warnings.some((warning: string) => warning.includes('Caption rerender failed'))).toBe(false);
      expect(finished.steps.every((step: { status: string }) => ['complete', 'skipped'].includes(step.status))).toBe(true);
      expect(finished.clips[0].libraryAssetId).toBe(clip.libraryAssetId);
      clip = finished.clips[0];
      const revised = await request.get(clip.downloadUrl);
      await fs.writeFile(path.join(fixtures!, 'reviewed.mp4'), await revised.body());
      if (item.audioMode === 'mix_original') verifyMix('reviewed.mp4');
      else verifyAudio('reviewed.mp4', 660);
      const sidecar = clip.captionDownloads.find((value: { format: string }) => value.format === 'srt');
      expect(await (await request.get(sidecar.url)).text()).toContain('Reviewed background song');
    }
    await page.reload();
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator(`.job-card[data-job-id="${queued.id}"]`).getByRole('button', { name: 'Open', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download ZIP/ }).click();
    const download = await downloadPromise;
    const archive = path.join(fixtures!, `export-${item.source}-${item.speed}-${item.audioMode || 'song-only'}.zip`);
    await download.saveAs(archive);
    const manifest = JSON.parse(zipEntry(archive, `${name}/manifest.json`));
    const credits = JSON.parse(zipEntry(archive, `${name}/credits.json`));
    if (item.audioMode) {
      expect(manifest.outputs[0].music_audio.mode).toBe(item.audioMode);
      expect(manifest.outputs[0].music_audio.song_gain).toBe(item.source !== 'none' && !item.silentVideo ? .1 : .25);
    }
    if (item.source !== 'none') {
      expect(manifest.outputs[0].music_track.speed).toBe(item.speed);
      expect(manifest.outputs[0].music_audio.mode).toBe(item.audioMode || 'song_only');
      expect(manifest.outputs[0].music_audio.song_gain).toBe(item.audioMode === 'mix_original' ? (item.silentVideo ? .25 : .1) : 1);
      expect(credits.credits.some((credit: { music_track?: { speed: number } }) => credit.music_track?.speed === item.speed)).toBe(true);
    }
    await testInfo.attach('persisted-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
  });
}
