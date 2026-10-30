#!/usr/bin/env node
/** Isolated real Music voice-replacement verification. Requires already prepared,
 * human-narrated fixtures and never injects transcript JSON or a downloader shim.
 * The runner is intentionally resource-gated: run from tmux on linuxpc, after the
 * active benchmark/container check, with one engine container capped at 3 GiB. */
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem, tmpdir, totalmem } from 'node:os';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureInput = process.env.S6_MUSIC_VOICE_FIXTURES;
if (!process.env.TMUX) throw new Error('Run this acceptance task inside tmux on linuxpc.');
if (!fixtureInput) throw new Error('Set S6_MUSIC_VOICE_FIXTURES to an isolated directory containing source.mp4, voice-only.mp4, replacement.mp3, voice-reference.wav, original-music-reference.wav and manifest.json.');
if (process.env.S6_TEST_TRANSCRIPT_JSON || process.env.S6_YTDLP_BIN) throw new Error('Real acceptance forbids test transcript injection and yt-dlp shims.');

const fixtures = resolve(fixtureInput);
const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'));
if (manifest.schema !== 1 || !Number.isFinite(manifest.speechWindow?.start) || !Number.isFinite(manifest.speechWindow?.duration) || !Number.isFinite(manifest.replacement?.metricFrequencyHz) || !Number.isFinite(manifest.lateStartMin)) {
  throw new Error('manifest.json must define schema=1, speechWindow.start/duration, replacement.metricFrequencyHz and lateStartMin.');
}
for (const file of ['source.mp4', 'voice-only.mp4', 'separation-failure.mp4', 'replacement.mp3', 'voice-reference.wav', 'original-music-reference.wav']) await readFile(join(fixtures, file));

const id = `s6-voice-replacement-${Date.now()}-${process.pid}`;
const artifacts = join(root, '.qa', id);
const engine = `${id}-engine`, web = `${id}-web`, pot = `${id}-pot`, network = `${id}-net`;
const engineImage = process.env.S6_MUSIC_VOICE_ENGINE_IMAGE || `${id}-engine-image`;
const webImage = process.env.S6_MUSIC_VOICE_WEB_IMAGE || `${id}-web-image`;
const bindData = await mkdtemp(join(resolve(process.env.S6_MUSIC_DATA_ROOT || tmpdir()), 's6-voice-replacement-data-'));
const browserTemp = process.env.S6_MUSIC_BROWSER_ROOT ? await mkdtemp(join(resolve(process.env.S6_MUSIC_BROWSER_ROOT), 's6-voice-replacement-browser-')) : null;
await mkdir(artifacts, { recursive: true });

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
function inspect(command, args) { return execFileSync(command, args, { encoding: 'utf8' }).trim(); }
function redactSignedUrls(value) { return value.replace(/([?&](?:expires|signature)=)[^&\s"'<>]+/gi, '$1[redacted]'); }
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function verifyNoBenchmark() {
  const containers = inspect('docker', ['ps', '--format', '{{.Names}} {{.Image}}']).split('\n').filter(Boolean);
  const benchmark = containers.filter(line => /voice.*bench|model.*bench|benchmark/i.test(line));
  if (benchmark.length) throw new Error(`Model benchmark container(s) active; refusing build/test: ${benchmark.join(', ')}`);
  const processes = inspect('ps', ['-eo', 'args=']).split('\n');
  const activeTest = processes.filter(line => /(playwright test|run-render-tests\.sh|run-nasa\.sh|bench\.sh)/i.test(line) && !line.includes(process.argv[1]));
  if (activeTest.length) throw new Error(`Another test or benchmark task is active; refusing concurrent work: ${activeTest.slice(0, 4).join(' | ')}`);
  const stats = inspect('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}']).split('\n').filter(Boolean);
  const disk = inspect('df', ['-Pk', root]).split('\n').at(-1)?.trim();
  console.log(`Resource preflight: RAM ${(freemem() / 1024 ** 3).toFixed(1)}/${(totalmem() / 1024 ** 3).toFixed(1)} GiB available/total; disk=${disk}; ${stats.length} running container(s); no active model benchmark/test detected.`);
}
verifyNoBenchmark();

let provisioned = false;
let passed = false;
try {
  // Jobs are serial. Build only when explicitly requested; do not consume the
  // 3 GiB engine budget while an independent benchmark is running.
  if (process.env.S6_MUSIC_VOICE_BUILD === '1') {
    await run('npm', ['run', 'build']);
    await run('docker', ['build', '--resource=memory=3g', '--resource=cpu-quota=300000', '-f', 'engine/Dockerfile', '-t', engineImage, '.']);
    await run('docker', ['build', '--resource=memory=1g', '--resource=cpu-quota=200000', '-f', 'Dockerfile', '-t', webImage, '.']);
  } else {
    for (const image of [engineImage, webImage]) {
      try { execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }); }
      catch { throw new Error(`Image ${image} is absent. Build in tmux after the model benchmark exits, or set the corresponding S6_MUSIC_VOICE_*_IMAGE to a prepared feature image.`); }
    }
  }

  for (const file of ['source.mp4', 'voice-only.mp4', 'separation-failure.mp4', 'replacement.mp3', 'voice-reference.wav', 'original-music-reference.wav', 'manifest.json']) {
    await cp(join(fixtures, file), join(artifacts, file));
  }
  // ffprobe fixture check inside a short lived, network-isolated container with
  // only the test directory mounted (no production data mounts).
  const probe = JSON.parse(inspect('docker', ['run', '--rm', '--network', 'none', '--memory=3g', '-v', `${artifacts}:/qa:ro`, '--entrypoint', 'ffprobe', engineImage, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', '/qa/source.mp4']));
  if (!probe.streams.some(stream => stream.codec_type === 'video') || !probe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('source.mp4 must contain both video and mixed voice/music audio.');
  await writeFile(join(artifacts, 'source-probe.json'), JSON.stringify(probe, null, 2));
} catch (error) {
  await writeFile(join(artifacts, 'preflight-failure.txt'), `${String(error)}\n`);
  await rm(bindData, { recursive: true, force: true });
  throw error;
}

// Provision only after preflight/fixture validation. The engine receives its
// standard runtime configuration; no fake transcript or downloader environment.
let created = false;
let networkCreated = false;
let potCreated = false;
try {
  await run('docker', ['network', 'create', network]);
  networkCreated = true;
  await run('docker', ['run', '-d', '--name', pot, '--network', network, '--network-alias', 'pot-provider', '--memory=384m', '--memory-swap=512m', '--cpus=0.75', '--pids-limit=128', 'brainicism/bgutil-ytdlp-pot-provider:1.3.2-deno']);
  potCreated = true;
  let potHealthy = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      await run('docker', ['exec', pot, 'deno', 'eval', "const r = await fetch('http://127.0.0.1:4416/ping'); if (!r.ok) Deno.exit(1)"]);
      potHealthy = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!potHealthy) throw new Error('Isolated YouTube proof-of-origin provider did not become healthy.');
  const port = await freePort();
  const dataUser = ['--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`];
  await run('docker', ['run', '-d', '--name', engine, ...dataUser, '--network', network, '--network-alias', 'engine', '--memory=3g', '--memory-swap=4g', '--cpus=3', '--pids-limit=512', '--mount', `type=bind,source=${bindData},target=/app/data`, '--tmpfs', '/tmp:rw,size=512m', '-v', `${root}/engine:/app/engine:ro`, '-v', `${artifacts}:/qa:ro`, engineImage]);
  await run('docker', ['run', '-d', '--name', web, '--network', network, '--memory=256m', '-p', `127.0.0.1:${port}:8080`, '-v', `${root}/web/dist:/usr/share/nginx/html:ro`, '-v', `${root}/docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, webImage]);
  created = true;
  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    try { if ((await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) })).ok) { healthy = true; break; } } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error('Isolated Music voice-replacement application did not become ready.');
  console.log(`Real voice replacement acceptance: ${url}; artifacts: ${artifacts}`);
  const desktopArgs = ['playwright', 'test', '--config', 'playwright.config.ts', 'tests/acceptance/music-voice-replacement-real.spec.ts', '--project=Desktop Chromium'];
  if (process.env.S6_MUSIC_VOICE_GREP) desktopArgs.push('--grep', process.env.S6_MUSIC_VOICE_GREP);
  await run('npx', desktopArgs, {
    ...process.env,
    S6_ACCEPTANCE_URL: url,
    S6_MUSIC_VOICE_FIXTURES: artifacts,
    S6_MUSIC_VOICE_CONTAINER: engine,
    S6_PLAYWRIGHT_ARTIFACTS: browserTemp || join(artifacts, 'playwright'),
  });
  await run('npx', ['playwright', 'test', '--config', 'playwright.config.ts', 'tests/acceptance/music-voice-replacement-real.spec.ts', '--project=Android Chromium', '--grep', 'mobile Music form'], {
    ...process.env,
    S6_ACCEPTANCE_URL: url,
    S6_MUSIC_VOICE_FIXTURES: artifacts,
    S6_MUSIC_VOICE_CONTAINER: engine,
    S6_PLAYWRIGHT_ARTIFACTS: browserTemp || join(artifacts, 'playwright-mobile'),
  });
  passed = true;
} finally {
  if (created) {
    for (const name of [engine, web]) {
      try { await writeFile(join(artifacts, `${name}.log`), redactSignedUrls(inspect('docker', ['logs', name]))); } catch (error) { await writeFile(join(artifacts, `${name}.log`), redactSignedUrls(String(error))); }
    }
    await run('docker', ['rm', '-f', web, engine]).catch(() => {});
  }
  if (potCreated) await run('docker', ['rm', '-f', pot]).catch(() => {});
  if (networkCreated) await run('docker', ['network', 'rm', network]).catch(() => {});
  if (browserTemp) await run('cp', ['-a', browserTemp, join(artifacts, 'playwright')]).catch(() => {});
  if (passed) await rm(bindData, { recursive: true, force: true });
  else await writeFile(join(artifacts, 'failed-data-path.txt'), `${bindData}\n`);
}
