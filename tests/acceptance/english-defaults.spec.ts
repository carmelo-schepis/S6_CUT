/** Opt-in real local Whisper + FFmpeg coverage. Run only on disposable data:
 * S6_ENGLISH_ACCEPTANCE_CONTAINER=<engine> S6_ENGLISH_ACCEPTANCE_OUTPUT=<directory>
 * S6_ACCEPTANCE_URL=http://127.0.0.1:<isolated-port> npx playwright test
 * tests/acceptance/english-defaults.spec.ts --project='Desktop Chromium'
 * Mount the output directory at /qa in the engine. Transcript fixtures are forbidden.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPlayback, capturePlaybackStills, checkPlayback, root } from './support/workspace';

const container = process.env.S6_ENGLISH_ACCEPTANCE_CONTAINER;
const output = process.env.S6_ENGLISH_ACCEPTANCE_OUTPUT;
const gateway = process.env.S6_ACCEPTANCE_URL;

for (const profile of ['speech', 'music'] as const) {
  test(`English defaults: real ${profile} transcription, captions, and video playback`, async ({ page, request }, testInfo) => {
    test.skip(!container || !output || !gateway, 'Requires an explicitly isolated engine, gateway, and output directory');
    test.skip(testInfo.project.name !== 'Desktop Chromium', 'Opt-in desktop release verification');
    expect(new URL(gateway!).port).not.toBe('8080');
    expect(process.env.S6_TEST_TRANSCRIPT_JSON).toBeUndefined();
    test.setTimeout(600_000);
    await fs.mkdir(output!, { recursive: true });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
    await page.getByLabel('Choose video file').setInputFiles(path.join(root, 'tests/fixtures/openrouter-fallback.mp4'));
    if (profile === 'music') {
      await page.getByRole('button', { name: 'Music / sung vocals' }).click();
      const language = page.getByRole('combobox', { name: 'Lyrics language' });
      await expect(language).toHaveValue('en');
      await language.selectOption('auto');
      await expect(language).toHaveValue('auto');
      await language.selectOption('fr');
      await expect(language).toHaveValue('fr');
      await language.selectOption('en');
    } else {
      await expect(page.getByRole('combobox', { name: 'Lyrics language' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Smart', exact: true }).click();
      await page.getByRole('button', { name: 'Engine only', exact: true }).click();
    }
    while (Number(await page.locator('.count-control strong').textContent()) > 1) {
      await page.getByRole('button', { name: 'Fewer clips' }).click();
    }
    await page.getByRole('button', { name: 'Advanced controls' }).click();
    await page.getByLabel('Minimum seconds').fill('8');
    await page.getByLabel('Maximum seconds').fill('20');
    await page.getByLabel('Project name').fill(`English default ${profile}`);
    const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/jobs/clip') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create 1 short clip', exact: true }).click();
    const created = await createdResponse;
    expect(created.status(), await created.text()).toBe(202);
    const { job: queued } = await created.json();
    const readJob = async () => {
      const response = await request.get(`/api/v1/jobs/${queued.id}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    await expect.poll(async () => {
      const job = await readJob();
      if (['failed', 'partial', 'stalled', 'cancelled_kept'].includes(job.state)) throw new Error(JSON.stringify(job));
      return job.state;
    }, { timeout: 480_000, intervals: [1000, 2000] }).toBe('complete');
    const job = await readJob();
    expect(job.clips).toHaveLength(1);
    const transcript = JSON.parse(execFileSync('docker', ['exec', container!, 'python', '-c',
      'import json,os,sys; from engine.app import db; assert "S6_TEST_TRANSCRIPT_JSON" not in os.environ; p=db.get_job_private(sys.argv[1]); print(json.dumps({"configured":p.get("transcription_language"),"transcript":p.get("transcript")}))', queued.id,
    ], { encoding: 'utf8' }));
    expect(transcript.configured).toBe('en');
    expect(transcript.transcript.language).toBe('en');
    expect(transcript.transcript.words.length).toBeGreaterThan(5);
    const text = transcript.transcript.words.map((word: { text: string }) => word.text).join(' ');
    expect(text).toMatch(/\b(the|this|is|and|video|engine)\b/i);
    await fs.writeFile(path.join(output!, `${profile}-transcript.json`), JSON.stringify(transcript, null, 2));

    await expect(page.locator('.clip-tile.complete')).toHaveCount(1);
    await page.locator('.clip-tile.complete').getByRole('button', { name: 'Preview', exact: true }).click();
    checkPlayback(await assertPlayback(page), profile);
    await capturePlaybackStills(page, output!, profile);
    const player = page.locator('.viewer-frame video');
    await player.evaluate(async (video: HTMLVideoElement) => {
      video.currentTime = 0;
      video.muted = true;
      const ended = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Full video playback did not finish')), (video.duration + 15) * 1000);
        video.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video failed during full playback')); }, { once: true });
      });
      await video.play();
      await ended;
    });
    const clip = job.clips[0];
    const download = await request.get(clip.downloadUrl);
    expect(download.ok()).toBeTruthy();
    await fs.writeFile(path.join(output!, `${profile}.mp4`), await download.body());
    const captions = clip.captionDownloads.find((item: { format: string }) => item.format === 'srt');
    expect(captions).toBeTruthy();
    const srt = await (await request.get(captions.url)).text();
    expect(srt).toMatch(/\b(the|this|is|and|video|engine)\b/i);
    await fs.writeFile(path.join(output!, `${profile}.srt`), srt);
    expect(pageErrors).toEqual([]);
    await fs.writeFile(path.join(output!, `${profile}-job.json`), JSON.stringify(job, null, 2));
    await testInfo.attach('real-transcript', { body: JSON.stringify(transcript), contentType: 'application/json' });
  });
}
