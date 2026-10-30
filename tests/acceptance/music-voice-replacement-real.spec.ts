/** Real Music voice replacement acceptance. This test deliberately leaves ASR and
 * source/song downloads on the production code paths: S6_TEST_TRANSCRIPT_JSON,
 * mocked transcripts, mocked separation and a yt-dlp shim are not supported.
 * Run through scripts/qa/verify-music-voice-replacement.mjs. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { zipEntry } from './support/workspace';

const fixtures = process.env.S6_MUSIC_VOICE_FIXTURES;
const container = process.env.S6_MUSIC_VOICE_CONTAINER;
const mode = 'replace_music_keep_voice';
const EXPECTED = {
  /** Defined before threshold tuning: 100 ms Hann-windowed 16 kHz mono RMS. */
  voiceRmsFloor: 0.008,
  /** Replacement marker amplitude at the speed-shifted fixture frequency. */
  replacementToneFloor: 0.004,
};

type MediaProbe = { format: { duration: string }; streams: { codec_type: string; codec_name: string; duration?: string }[] };

function execInEngine(args: string[]) {
  return execFileSync('docker', ['exec', container!, ...args], { maxBuffer: 128 * 1024 * 1024 });
}

async function saveClip(request: any, clip: any, name: string) {
  const response = await request.get(clip.downloadUrl);
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = Buffer.from(await response.body());
  await fs.writeFile(path.join(fixtures!, name), body);
  return body;
}

function probe(filename: string): MediaProbe {
  return JSON.parse(execInEngine(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', `/qa/${filename}`]).toString());
}

function decodedAudio(filename: string, start = 0, duration = 8) {
  return execInEngine(['ffmpeg', '-v', 'error', '-ss', String(start), '-i', `/qa/${filename}`, '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
}

function decodedReference(filename: string, start: number, duration: number) {
  return execInEngine(['ffmpeg', '-v', 'error', '-ss', String(start), '-i', `/qa/${filename}`, '-t', String(duration), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
}

/** RMS and Goertzel tone amplitude are stable, auditable fixture metrics. The
 * audio fixture manifest provides the speech window and replacement tone/frequency.
 * Thresholds are declared above and must not be tuned from a failing output. */
function audioMetrics(raw: Buffer, frequency: number) {
  const rate = 16000;
  let power = 0, real = 0, imaginary = 0;
  for (let i = 0; i < raw.length / 4; i++) {
    const value = raw.readFloatLE(i * 4);
    power += value * value;
    const angle = 2 * Math.PI * frequency * i / rate;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  const count = raw.length / 4;
  return { rms: Math.sqrt(power / count), tone: 2 * Math.hypot(real, imaginary) / count };
}

function normalizedCorrelation(left: Buffer, right: Buffer) {
  const count = Math.min(left.length, right.length) / 4;
  let dot = 0, leftPower = 0, rightPower = 0;
  for (let i = 0; i < count; i++) {
    const a = left.readFloatLE(i * 4), b = right.readFloatLE(i * 4);
    dot += a * b; leftPower += a * a; rightPower += b * b;
  }
  return dot / Math.sqrt(leftPower * rightPower);
}

async function waitForTerminal(request: any, id: string) {
  const read = async () => {
    const response = await request.get(`/api/v1/jobs/${id}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  await expect.poll(async () => {
    const value = await read();
    if (['failed', 'partial', 'stalled', 'cancelled_kept'].includes(value.state)) throw new Error(JSON.stringify(value));
    return value.state === 'complete' && value.steps.every((step: any) => ['complete', 'skipped'].includes(step.status));
  }, { timeout: 600_000, intervals: [500, 1000, 2500] }).toBe(true);
  return read();
}

async function submit(page: any, request: any, options: { name: string; source: 'upload' | 'youtube'; gain: number; speed: number; late: boolean; replacement: 'upload' | 'youtube' | 'invalid' | 'none'; audioMode?: 'replace_music_keep_voice' | 'song_only' | 'mix_original'; video?: string; expectedStatus?: number }) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
  if (options.source === 'upload') {
    await page.getByLabel('Choose video file').setInputFiles(path.join(fixtures!, options.video || 'source.mp4'));
  } else {
    await page.getByRole('tab', { name: 'YouTube', exact: true }).click();
    await page.getByLabel('YouTube URL', { exact: true }).fill(process.env.S6_MUSIC_VOICE_YOUTUBE_SOURCE!);
  }
  await page.getByRole('button', { name: 'Music / sung vocals' }).click();
  while (Number(await page.locator('.count-control strong').textContent()) > 1) await page.getByRole('button', { name: 'Fewer clips' }).click();
  if (options.replacement === 'upload') {
    await page.getByLabel('Background song MP3').setInputFiles(path.join(fixtures!, 'replacement.mp3'));
  } else if (options.replacement === 'invalid') {
    await page.getByLabel('Background song MP3').setInputFiles(path.join(fixtures!, 'invalid-song.mp3'));
  } else if (options.replacement === 'youtube') {
    await page.getByLabel('YouTube song URL').fill(process.env.S6_MUSIC_VOICE_YOUTUBE_SONG!);
  }
  const audioMode = options.audioMode || mode;
  if (audioMode === mode) await page.getByRole('button', { name: /Keep voice, replace background music/i }).click();
  else await page.getByRole('button', { name: audioMode === 'song_only' ? 'Song only' : 'Original audio + song', exact: true }).click();
  await page.getByLabel('Song speed').selectOption(String(options.speed));
  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await page.getByLabel('Minimum seconds').fill('8');
  await page.getByLabel('Maximum seconds').fill('10');
  await page.getByLabel('Project name').fill(options.name);
  // Gain is collected and submitted as part of the mode; 0% explicitly tests that
  // the separated voice remains even when the replacement song is silent.
  if (options.replacement !== 'none' && audioMode !== 'song_only') await page.getByRole('slider', { name: /replacement song volume|background song volume/i }).fill(String(options.gain));
  const creation = page.waitForResponse((response: any) => response.url().endsWith('/api/v1/jobs/clip') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create 1 short clip', exact: true }).click();
  const response = await creation;
  expect(response.status(), await response.text()).toBe(options.expectedStatus ?? 202);
  const payload = await response.json();
  if (response.status() !== 202) return payload;
  const { job } = payload;
  expect(job.musicAudioMode).toBe(audioMode);
  if (options.replacement !== 'none' && audioMode !== 'song_only') expect(job.musicSongGain).toBe(options.gain / 100);
  return job;
}

test('Music replacement keeps real speech, replaces the song, and survives persisted edits, restart, refresh and export', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through scripts/qa/verify-music-voice-replacement.mjs with real media fixtures');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Mobile layout is covered by the dedicated responsive case below');
  test.setTimeout(1_200_000);
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures!, 'manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema: 1, speechWindow: { start: expect.any(Number), duration: expect.any(Number) }, replacement: { metricFrequencyHz: expect.any(Number) }, lateStartMin: expect.any(Number) });
  expect(process.env.S6_TEST_TRANSCRIPT_JSON).toBeUndefined();
  expect(process.env.S6_YTDLP_BIN).toBeUndefined();

  const sourceProbe = JSON.parse(await fs.readFile(path.join(fixtures!, 'source-probe.json'), 'utf8')) as MediaProbe;
  expect(sourceProbe.streams.some(stream => stream.codec_type === 'video')).toBe(true);
  expect(sourceProbe.streams.some(stream => stream.codec_type === 'audio')).toBe(true);
  expect(Number(sourceProbe.format.duration)).toBeGreaterThan(manifest.lateStartMin + 10);
  const name = `Voice replacement ${Date.now()}`;
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(String(error)));
  page.on('requestfailed', request => {
    const detail = request.failure()?.errorText || '';
    if (!['net::ERR_ABORTED', 'Load request cancelled'].includes(detail)) requestFailures.push(`${request.method()} ${request.url()}: ${detail}`);
  });
  const queued = await submit(page, request, { name, source: 'upload', gain: 10, speed: 1.25, late: true, replacement: 'upload' });
  const job = await waitForTerminal(request, queued.id);
  expect(job.musicAudioMode).toBe(mode);
  expect(job.musicSongGain).toBe(.1);
  expect(job.clips).toHaveLength(1);
  expect(job.state).toBe('complete');
  expect(job.steps.every((step: any) => ['complete', 'skipped'].includes(step.status))).toBe(true);
  expect(job.steps.find((step: any) => step.id === 'transcribe')?.status, 'local ASR must run on the submitted media').toBe('complete');
  expect(job.steps.find((step: any) => step.id === 'audio')?.status, 'the real separator must run; no fallback mix can satisfy this case').toBe('complete');
  const clip = job.clips[0];
  expect(clip.start).toBeGreaterThanOrEqual(manifest.lateStartMin, 'the case must exercise a late source segment');
  await expect(page.locator('.clip-tile.complete')).toHaveCount(1);
  const bytes = await saveClip(request, clip, 'replacement-output.mp4');
  const outputProbe = probe('replacement-output.mp4');
  expect(outputProbe.streams.some(stream => stream.codec_type === 'video')).toBe(true);
  expect(outputProbe.streams.some(stream => stream.codec_type === 'audio')).toBe(true);
  const duration = Number(outputProbe.format.duration);
  expect(duration).toBeGreaterThan(7);
  expect(duration).toBeLessThan(11);
  const window = manifest.speechWindow;
  expect(clip.start).toBeLessThan(window.start);
  expect(clip.start + duration).toBeGreaterThan(window.start + window.duration);
  const expectedToneHz = manifest.replacement.metricFrequencyHz * 1.25;
  const audio = audioMetrics(decodedAudio('replacement-output.mp4', Math.max(0, window.start - clip.start), window.duration), expectedToneHz);
  const speechCorr = normalizedCorrelation(
    decodedAudio('replacement-output.mp4', window.start - clip.start, window.duration),
    decodedReference('voice-reference.wav', window.start, window.duration),
  );
  const originalMusicCorr = normalizedCorrelation(
    decodedAudio('replacement-output.mp4', window.start - clip.start, window.duration),
    decodedReference('original-music-reference.wav', window.start, window.duration),
  );
  expect(audio.rms, 'voice remains audible in the human speech window').toBeGreaterThan(EXPECTED.voiceRmsFloor);
  expect(speechCorr, 'rendered speech remains correlated with the known clean source voice stem').toBeGreaterThan(0.15);
  expect(Math.abs(originalMusicCorr), 'the source accompaniment is removed').toBeLessThan(0.35);
  expect(audio.tone, 'the uploaded replacement song remains in the render').toBeGreaterThan(EXPECTED.replacementToneFloor);
  const originalHash = crypto.createHash('sha256').update(bytes).digest('hex');

  // Caption rerender after deleting disposable job work files proves the published
  // render can be reconstructed using persisted mode, gain, source and replacement.
  execFileSync('docker', ['exec', container!, 'python', '-c', 'import shutil,sys; shutil.rmtree("/app/data/jobs/"+sys.argv[1])', queued.id]);
  execFileSync('docker', ['restart', '--timeout=1', container!]);
  await expect.poll(async () => { try { return (await request.get('/api/v1/health')).status(); } catch { return 0; } }, { timeout: 300_000 }).toBe(200);
  // Requests racing the deliberate restart may receive nginx 502 responses.
  // Clear those before recovery reload so that the reload itself remains checked.
  consoleErrors.length = 0;
  requestFailures.length = 0;
  await page.reload();
  const edited = await request.put(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions`, { data: { revision: clip.captionRevision, cues: [{ id: 'qa-voice', start: 0.2, end: 2, text: 'Narration remains while the music changes' }] } });
  expect(edited.ok(), await edited.text()).toBeTruthy();
  const revision = (await edited.json()).clips[0].captionRevision;
  expect((await request.post(`/api/v1/jobs/${queued.id}/clips/${clip.id}/captions/rerender?revision=${revision}`)).ok()).toBe(true);
  await expect.poll(async () => { const current = await request.get(`/api/v1/jobs/${queued.id}`).then(value => value.json()); return current.state === 'complete' && current.clips[0].blobId !== clip.blobId; }, { timeout: 300_000 }).toBe(true);
  const editedJob = await request.get(`/api/v1/jobs/${queued.id}`).then(value => value.json());
  expect(editedJob.musicAudioMode).toBe(mode);
  expect(editedJob.musicSongGain).toBe(.1);
  const rerenderBytes = await saveClip(request, editedJob.clips[0], 'replacement-rerender.mp4');
  expect(crypto.createHash('sha256').update(rerenderBytes).digest('hex')).not.toBe(originalHash);
  const rerenderProbe = probe('replacement-rerender.mp4');
  expect(rerenderProbe.streams.some(stream => stream.codec_type === 'audio')).toBe(true);
  const sidecar = editedJob.clips[0].captionDownloads.find((item: any) => item.format === 'srt');
  expect(await request.get(sidecar.url).then(value => value.text())).toContain('Narration remains while the music changes');

  await page.reload();
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.locator(`.job-card[data-job-id="${queued.id}"]`).getByRole('button', { name: 'Open', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download ZIP/ }).click();
  const archive = path.join(fixtures!, 'replacement-export.zip');
  await (await downloadPromise).saveAs(archive);
  const projectName = job.projectName || name;
  const manifestOut = JSON.parse(zipEntry(archive, `${projectName}/manifest.json`));
  expect(manifestOut.outputs[0].music_audio.mode).toBe(mode);
  expect(manifestOut.outputs[0].music_audio.song_gain).toBe(.1);
  const zippedHash = execFileSync('python3', ['-I', '-c', 'import hashlib,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint("\\n".join(hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith(".mp4")))', archive]).toString().trim().split('\n');
  expect(zippedHash).toContain(crypto.createHash('sha256').update(rerenderBytes).digest('hex'));
  expect(consoleErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  await testInfo.attach('terminal-job', { body: JSON.stringify(editedJob, null, 2), contentType: 'application/json' });
  await testInfo.attach('measured-audio', { body: JSON.stringify({ mode, gain: .1, speechRms: audio.rms, speechStemCorrelation: speechCorr, originalMusicStemCorrelation: originalMusicCorr, replacementToneAmplitude: audio.tone, expectedFrequencyHz: expectedToneHz, thresholds: { ...EXPECTED, speechStemCorrelationFloor: 0.15, originalMusicStemCorrelationMaxAbs: 0.35 }, outputDurationSeconds: duration }, null, 2), contentType: 'application/json' });
});

test('Music voice-only remains when replacement gain is zero and both legacy Music modes remain selectable', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through the isolated voice replacement harness');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Mobile has its own layout check');
  test.setTimeout(900_000);
  const name = `Voice only ${Date.now()}`;
  const queued = await submit(page, request, { name, source: 'upload', gain: 0, speed: 1, late: false, replacement: 'upload', video: 'voice-only.mp4' });
  const job = await waitForTerminal(request, queued.id);
  expect(job.musicAudioMode).toBe(mode);
  expect(job.musicSongGain).toBe(0);
  const clip = job.clips[0];
  const bytes = await saveClip(request, clip, 'voice-only-output.mp4');
  expect(bytes.length).toBeGreaterThan(10_000);
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures!, 'manifest.json'), 'utf8'));
  const speechOffset = manifest.speechWindow.start - clip.start;
  const audio = audioMetrics(decodedAudio('voice-only-output.mp4', speechOffset, manifest.speechWindow.duration), manifestFrequency());
  expect(audio.rms).toBeGreaterThan(EXPECTED.voiceRmsFloor);
  expect(audio.tone).toBeLessThan(EXPECTED.replacementToneFloor, '0% song gain removes song while keeping voice');
  await testInfo.attach('voice-only-job', { body: JSON.stringify(job, null, 2), contentType: 'application/json' });
});

test('Music voice-only works with no replacement song selected', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through the isolated voice replacement harness');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop real-media case only');
  test.setTimeout(900_000);
  const queued = await submit(page, request, { name: `No replacement song ${Date.now()}`, source: 'upload', gain: 0, speed: 1, late: false, replacement: 'none' });
  const job = await waitForTerminal(request, queued.id);
  expect(job.musicAudioMode).toBe(mode);
  expect(job.musicTrack).toBeNull();
  expect(job.steps.find((step: any) => step.id === 'audio')?.status).toBe('complete');
  const clip = job.clips[0];
  const bytes = await saveClip(request, clip, 'no-replacement-output.mp4');
  expect(bytes.length).toBeGreaterThan(10_000);
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures!, 'manifest.json'), 'utf8'));
  const speechOffset = manifest.speechWindow.start - clip.start;
  const decoded = decodedAudio('no-replacement-output.mp4', speechOffset, manifest.speechWindow.duration);
  const voice = decodedReference('voice-reference.wav', manifest.speechWindow.start, manifest.speechWindow.duration);
  const metric = audioMetrics(decoded, manifestFrequency());
  expect(metric.rms).toBeGreaterThan(EXPECTED.voiceRmsFloor);
  expect(metric.tone).toBeLessThan(EXPECTED.replacementToneFloor);
  expect(normalizedCorrelation(decoded, voice)).toBeGreaterThan(.15);
});

function manifestFrequency() {
  return Number(JSON.parse(requireManifest()).replacement.metricFrequencyHz);
}

function requireManifest() {
  return execFileSync('cat', [path.join(fixtures!, 'manifest.json')], { encoding: 'utf8' });
}

test('live YouTube source with uploaded replacement uses the production downloader when configured', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container || !process.env.S6_MUSIC_VOICE_YOUTUBE_SOURCE, 'No verified live YouTube source URL configured; no mocked downloader is permitted');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop live YouTube case only');
  test.setTimeout(1_200_000);
  const job = await submit(page, request, { name: `Live YouTube source voice replacement ${Date.now()}`, source: 'youtube', gain: 10, speed: 1, late: false, replacement: 'upload' });
  const finished = await waitForTerminal(request, job.id);
  expect(finished.musicAudioMode).toBe(mode);
  expect(finished.musicSongGain).toBe(.1);
  const projectResponse = await request.get(`/api/v1/projects/${finished.projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  expect((await projectResponse.json()).sourceKind).toBe('youtube');
  expect(finished.state).toBe('complete');
  await testInfo.attach('live-youtube-source-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
});

test('live YouTube replacement song with uploaded human source uses the production downloader when configured', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container || !process.env.S6_MUSIC_VOICE_YOUTUBE_SONG, 'No verified live YouTube replacement URL configured; no mocked downloader is permitted');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop live YouTube case only');
  test.setTimeout(1_200_000);
  const job = await submit(page, request, { name: `Live YouTube song voice replacement ${Date.now()}`, source: 'upload', gain: 10, speed: 1, late: false, replacement: 'youtube' });
  const finished = await waitForTerminal(request, job.id);
  expect(finished.musicAudioMode).toBe(mode);
  expect(finished.musicSongGain).toBe(.1);
  expect(finished.musicTrack).toMatchObject({ source: 'youtube', speed: 1 });
  expect(finished.state).toBe('complete');
  await testInfo.attach('live-youtube-song-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
});

test('live YouTube source and distinct YouTube replacement song complete through production downloading', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container || !process.env.S6_MUSIC_VOICE_YOUTUBE_SOURCE || !process.env.S6_MUSIC_VOICE_YOUTUBE_SONG, 'Both verified live YouTube URLs are required; no mocked downloader is permitted');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop live YouTube case only');
  test.setTimeout(1_200_000);
  const queued = await submit(page, request, { name: `Live YouTube source and song ${Date.now()}`, source: 'youtube', gain: 10, speed: 1.25, late: false, replacement: 'youtube' });
  const finished = await waitForTerminal(request, queued.id);
  const projectResponse = await request.get(`/api/v1/projects/${finished.projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  expect((await projectResponse.json()).sourceKind).toBe('youtube');
  expect(finished.musicAudioMode).toBe(mode);
  expect(finished.musicSongGain).toBe(.1);
  expect(finished.musicTrack).toMatchObject({ source: 'youtube', speed: 1.25 });
  expect(finished.steps.find((step: any) => step.id === 'audio')?.status).toBe('complete');
  expect(finished.steps.find((step: any) => step.id === 'transcribe')?.status).toBe('complete');
  expect(finished.state).toBe('complete');
  await testInfo.attach('live-youtube-source-and-song-job', { body: JSON.stringify(finished, null, 2), contentType: 'application/json' });
});

test('a real unsupported separator input fails with a clear terminal error, without fallback audio', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through the isolated voice replacement harness');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop separation-failure case only');
  test.setTimeout(300_000);
  const queued = await submit(page, request, { name: `Separator failure ${Date.now()}`, source: 'upload', gain: 10, speed: 1, late: false, replacement: 'none', video: 'separation-failure.mp4' });
  await expect.poll(async () => request.get(`/api/v1/jobs/${queued.id}`).then(response => response.json().then(value => value.state)), { timeout: 240_000 }).toBe('failed');
  const failed = await request.get(`/api/v1/jobs/${queued.id}`).then(response => response.json());
  expect(failed.musicAudioMode).toBe(mode);
  expect(failed.error).toMatch(/one or two channels/i);
  expect(failed.steps.find((step: any) => step.id === 'audio')?.status).toBe('failed');
  expect(failed.steps.every((step: any) => step.status !== 'active')).toBe(true);
  expect(failed.clips).toHaveLength(0);
  await expect(page.getByRole('alert')).toContainText(/one or two channels/i);
  await testInfo.attach('separator-failure-job', { body: JSON.stringify(failed, null, 2), contentType: 'application/json' });
});

test('a real invalid replacement song ends in a durable failed job with diagnostics', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through the isolated voice replacement harness');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop failure case only');
  test.setTimeout(300_000);
  const bad = path.join(fixtures!, 'invalid-song.mp3');
  await fs.writeFile(bad, Buffer.from('not an MP3 file\n'));
  const rejected = await submit(page, request, { name: `Invalid replacement ${Date.now()}`, source: 'upload', gain: 10, speed: 1, late: false, replacement: 'invalid', expectedStatus: 422 });
  expect(rejected.detail).toMatch(/uploaded MP3 could not be read/i);
  await expect(page.getByRole('alert')).toContainText(/could not be read/i);
});

test('a real submitted voice replacement job can be stopped and remains terminal after refresh', async ({ page, request }, testInfo) => {
  test.skip(!fixtures || !container, 'Run only through the isolated voice replacement harness');
  test.skip(testInfo.project.name.startsWith('iPhone') || testInfo.project.name.startsWith('iPad'), 'Desktop cancellation case only');
  test.setTimeout(600_000);
  const queued = await submit(page, request, { name: `Cancel voice replacement ${Date.now()}`, source: 'upload', gain: 10, speed: 1, late: false, replacement: 'upload' });
  const stop = page.getByRole('button', { name: /Stop & keep/ });
  await expect(stop).toBeVisible({ timeout: 90_000 });
  await stop.click();
  await expect.poll(async () => request.get(`/api/v1/jobs/${queued.id}`).then(response => response.json().then(value => value.state)), { timeout: 120_000 }).toBe('cancelled_kept');
  await page.reload();
  const cancelled = await request.get(`/api/v1/jobs/${queued.id}`).then(response => response.json());
  expect(cancelled.state).toBe('cancelled_kept');
  expect(cancelled.musicAudioMode).toBe(mode);
  expect(cancelled.steps.every((step: any) => !['active', 'pending'].includes(step.status))).toBe(true);
  await testInfo.attach('cancelled-job', { body: JSON.stringify(cancelled, null, 2), contentType: 'application/json' });
});

test('mobile Music form has no horizontal overflow and exposes replacement mode', async ({ page }, testInfo) => {
  test.skip(!fixtures || !container || !testInfo.project.name.startsWith('Android'), 'Mobile layout case uses Android Chromium in the isolated harness');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
  await page.getByRole('button', { name: 'Music / sung vocals' }).click();
  await page.getByLabel('Choose video file').setInputFiles(path.join(fixtures!, 'source.mp4'));
  await page.getByLabel('Background song MP3').setInputFiles(path.join(fixtures!, 'replacement.mp3'));
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  await page.getByRole('button', { name: /Keep voice, replace background music/i }).waitFor({ state: 'visible', timeout: 5_000 });
});

test('voice replacement control is scoped to Music mode', async ({ page }, testInfo) => {
  test.skip(!fixtures || !container || testInfo.project.name !== 'Desktop Chromium', 'Desktop isolated UI case');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Keep voice, replace background music/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Music / sung vocals' }).click();
  await page.getByLabel('Background song MP3').setInputFiles(path.join(fixtures!, 'replacement.mp3'));
  const replacementMode = page.getByRole('button', { name: /Keep voice, replace background music/i });
  await expect(replacementMode).toBeVisible();
  await expect(replacementMode).toHaveAttribute('aria-pressed', 'false');
  await replacementMode.focus();
  await expect(replacementMode).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(replacementMode).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clip mode', exact: true }).click();
  await expect(replacementMode).toHaveCount(0);
});
