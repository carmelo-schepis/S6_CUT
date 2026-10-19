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
const cases = [
  { source: 'upload', speed: 1 },
  { source: 'upload', speed: 1.5 },
  { source: 'youtube', speed: .75 },
  { source: 'none', speed: 1 },
];

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
  test(`real soundtrack: ${item.source} at ${item.speed}x`, async ({ page, request }, testInfo) => {
    test.skip(!fixtures || !container, 'Use the isolated soundtrack verification harness');
    test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'iOS provides a read-only status view');
    test.setTimeout(900_000);
    const name = `Soundtrack ${item.source} ${item.speed} ${Date.now()}`;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
    await page.getByLabel('Choose video file').setInputFiles(path.join(fixtures!, item.source === 'none' ? 'with-audio.mp4' : 'silent.mp4'));
    await page.getByRole('button', { name: 'Music / sung vocals' }).click();
    while (Number(await page.locator('.count-control strong').textContent()) > 1) {
      await page.getByRole('button', { name: 'Fewer clips' }).click();
    }
    // The title deliberately matches a lyric: audio must never become a visual overlay.
    if (item.source === 'upload') await page.getByLabel('Background song MP3').setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: await fs.readFile(path.join(fixtures!, 'short-song.mp3')) });
    if (item.source === 'youtube') await page.getByLabel('YouTube song URL').fill('https://music.youtube.com/watch?v=BaW_jenozKc');
    await page.getByLabel('Song speed').selectOption(String(item.speed));
    await page.getByRole('button', { name: 'Advanced controls' }).click();
    await page.getByLabel('Minimum seconds').fill('8');
    await page.getByLabel('Maximum seconds').fill('10');
    await page.getByLabel('Project name').fill(name);
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
    expect(finished.steps.every((step: { status: string }) => ['complete', 'skipped'].includes(step.status))).toBe(true);
    if (item.source === 'none') expect(finished.musicTrack).toBeNull();
    else expect(finished.musicTrack).toMatchObject({ source: item.source === 'upload' ? 'upload' : 'youtube', speed: item.speed });
    await expect(page.locator('.clip-tile.complete')).toHaveCount(1);
    await page.locator('.clip-tile.complete').getByRole('button', { name: 'Preview', exact: true }).click();
    checkPlayback(await assertPlayback(page), name);
    let clip = finished.clips[0];
    const filename = `output-${item.source}-${item.speed}.mp4`;
    const output = await request.get(clip.downloadUrl);
    expect(output.ok()).toBeTruthy();
    await fs.writeFile(path.join(fixtures!, filename), await output.body());
    verifyAudio(filename, item.source === 'none' ? 220 : 660 * item.speed);

    if (item.source === 'upload' && item.speed === 1) {
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
      verifyAudio('reviewed.mp4', 660);
      const sidecar = clip.captionDownloads.find((value: { format: string }) => value.format === 'srt');
      expect(await (await request.get(sidecar.url)).text()).toContain('Reviewed background song');
    }
    await page.reload();
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator(`.job-card[data-job-id="${queued.id}"]`).getByRole('button', { name: 'Open', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download ZIP/ }).click();
    const download = await downloadPromise;
    const archive = path.join(fixtures!, `export-${item.source}-${item.speed}.zip`);
    await download.saveAs(archive);
    const manifest = JSON.parse(zipEntry(archive, `${name}/manifest.json`));
    const credits = JSON.parse(zipEntry(archive, `${name}/credits.json`));
    if (item.source !== 'none') {
      expect(manifest.outputs[0].music_track.speed).toBe(item.speed);
      expect(credits.credits.some((credit: { music_track?: { speed: number } }) => credit.music_track?.speed === item.speed)).toBe(true);
    }
    await testInfo.attach('persisted-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
  });
}
