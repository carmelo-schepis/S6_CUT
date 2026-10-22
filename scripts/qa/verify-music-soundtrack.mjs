#!/usr/bin/env node
/** Isolated real media integration gate. ASR timestamps and yt-dlp transport are
 * controlled to make speed, loops, persistence and recovery reproducible. */
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const id = `s6-music-check-${Date.now()}-${process.pid}`;
const artifacts = join(root, '.qa', id);
const engine = `${id}-engine`, web = `${id}-web`, network = `${id}-net`, volume = `${id}-data`;
const engineImage = process.env.S6_MUSIC_ENGINE_IMAGE || `${id}-engine`;
const webImage = process.env.S6_MUSIC_WEB_IMAGE || `${id}-web`;
await mkdir(artifacts, { recursive: true });
const bindData = await mkdtemp(join(resolve(process.env.S6_MUSIC_DATA_ROOT || tmpdir()), 's6-music-data-'));
const browserTemp = process.env.S6_MUSIC_BROWSER_ROOT ? await mkdtemp(join(resolve(process.env.S6_MUSIC_BROWSER_ROOT), 's6-music-browser-')) : null;
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
const port = await freePort();
const words = [];
for (let line = 0; line < 3; line++) {
  const text = ['Follow', 'the', 'selected', 'background', 'song', 'through', 'this', 'whole', 'video.'];
  for (let word = 0; word < text.length; word++) words.push({ text: text[word], start: line * 10 + word, end: line * 10 + word + .9, confidence: .99 });
}
await writeFile(join(artifacts, 'runtime.env'), `S6_TEST_TRANSCRIPT_JSON=${JSON.stringify({ language: 'en', words, segments: [{ start: 0, end: 28.9, text: 'Follow the selected background song through this whole video.' }] })}\nS6_YTDLP_BIN=/qa/song-ytdlp.py\n`);
await writeFile(join(artifacts, 'song-ytdlp.py'), `#!/usr/bin/env python3
import json,shutil,sys,time
from pathlib import Path
output=Path(sys.argv[sys.argv.index('--output')+1].replace('%(ext)s','mp3'))
output.parent.mkdir(parents=True,exist_ok=True)
print('download:downloading|100|1000|NA|100|9|10.0%',flush=True)
time.sleep(.2)
shutil.copyfile('/qa/short-song.mp3',output)
output.with_suffix('.info.json').write_text(json.dumps({'title':'Controlled YouTube song'}))
print('download:finished|1000|1000|NA|200|0|100.0%',flush=True)
`);
await chmod(join(artifacts, 'song-ytdlp.py'), 0o755);
let provisioned = false;
let testPassed = false;
try {
  if (!process.env.S6_MUSIC_ENGINE_IMAGE) await run('docker', ['build', '-f', 'engine/Dockerfile', '-t', engineImage, '.']);
  if (!process.env.S6_MUSIC_WEB_IMAGE) await run('docker', ['build', '-f', 'Dockerfile', '-t', webImage, '.']);
  await run('npm', ['run', 'build']);
  const fixtureCommands = [
    ['-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=12:d=30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '/out/silent.mp4'],
    ['-i', '/out/silent.mp4', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '/out/with-audio.mp4'],
    ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=4', '-codec:a', 'libmp3lame', '-q:a', '4', '/out/short-song.mp3'],
  ];
  await run('docker', ['run', '--rm', '--user', '0', '--network', 'none', '-v', `${artifacts}:/out`, '--entrypoint', 'python', engineImage, '-c', 'import json,subprocess,sys\nfor args in json.loads(sys.argv[1]): subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y",*args],check=True)', JSON.stringify(fixtureCommands)]);
  provisioned = true;
  await run('docker', ['network', 'create', network]);
  if (!bindData) await run('docker', ['volume', 'create', volume]);
  const dataMount = bindData ? `type=bind,source=${bindData},target=/app/data` : `type=volume,source=${volume},target=/app/data`;
  const dataUser = bindData ? ['--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`] : [];
  await run('docker', ['run', '-d', '--name', engine, ...dataUser, '--network', network, '--network-alias', 'engine', '--mount', dataMount, '--tmpfs', '/tmp:rw,size=512m', '-v', `${root}/engine:/app/engine:ro`, '-v', `${artifacts}:/qa:ro`, '--env-file', join(artifacts, 'runtime.env'), engineImage]);
  await run('docker', ['run', '-d', '--name', web, '--network', network, '-p', `127.0.0.1:${port}:8080`, '-v', `${root}/web/dist:/usr/share/nginx/html:ro`, '-v', `${root}/docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, webImage]);
  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    try { if ((await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) })).ok) { healthy = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error('Isolated gateway did not become ready');
  console.log(`Real media verification at ${url}; evidence: ${artifacts}`);
  await run('npx', ['playwright', 'test', '--config', 'playwright.config.ts', 'tests/acceptance/music-soundtrack-real.spec.ts', '--project=Desktop Chromium'], { ...process.env, S6_ACCEPTANCE_URL: url, S6_SOUNDTRACK_FIXTURES: artifacts, S6_SOUNDTRACK_CONTAINER: engine, S6_PLAYWRIGHT_ARTIFACTS: browserTemp || join(artifacts, 'playwright') });
  testPassed = true;
} finally {
  if (provisioned) {
    try {
      const logs = execFileSync('docker', ['logs', engine], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      await writeFile(join(artifacts, 'engine.log'), logs);
    } catch (error) {
      await writeFile(join(artifacts, 'engine.log'), String(error));
    }
    await run('docker', ['rm', '-f', web, engine]).catch(() => {});
    await run('docker', ['network', 'rm', network]).catch(() => {});
  }
  if (bindData) {
    if (testPassed) await rm(bindData, { recursive: true, force: true });
    else await writeFile(join(artifacts, 'failed-data-path.txt'), bindData + '\n');
  } else if (provisioned) {
    await run('docker', ['volume', 'rm', volume]).catch(() => {});
  }
  if (browserTemp) {
    await cp(browserTemp, join(artifacts, 'playwright'), { recursive: true });
    await rm(browserTemp, { recursive: true, force: true });
  }
}
