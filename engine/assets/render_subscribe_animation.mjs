/** Offline SVG frames, sampled explicitly at 30 fps. No browser animation clock. */
import { chromium } from 'playwright';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [output, ffmpeg, root] = process.argv.slice(2);
if (!output || !ffmpeg || !root) throw new Error('Usage: render_subscribe_animation.mjs OUTPUT FFMPEG ROOT');
const run = (args) => {
  const result = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFmpeg exited ${result.status}`);
};
run(['-version']);
const temp = await mkdtemp(path.join(os.tmpdir(), 's6-subscribe-'));
let browser;
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const phase = (t, start, end) => ease((t - start) / (end - start));
const mix = (a, b, p) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * p)).join(',')})`;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1536, height: 540 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort());
  const font = (await readFile(path.join(root, 'engine/fonts/montserrat/Montserrat-Bold.ttf'))).toString('base64');
  await page.setContent(`<style>body{margin:0;background:transparent}@font-face{font-family:Subscribe;src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:700}</style><main></main>`);
  await page.evaluate(async () => { await document.fonts.load('700 86px Subscribe'); await document.fonts.ready; });
  for (let frame = 0; frame < 120; frame++) {
    const t = frame / 30;
    const enter = phase(t, 0, .3), exit = phase(t, 3.3, 119 / 30);
    const opacity = enter * (1 - exit);
    const press = phase(t, 1.05, 1.14) * (1 - phase(t, 1.23, 1.4));
    const subscribed = phase(t, 1.27, 1.6);
    const oldLabel = 1 - phase(t, 1.25, 1.4), newLabel = phase(t, 1.4, 1.6);
    const scale = 1 - .025 * press;
    const travel = phase(t, .35, 1.05), withdraw = phase(t, 1.85, 2.3);
    const cursorOpacity = phase(t, .35, .48) * (1 - withdraw);
    const cx = 1110 - 190 * travel + 70 * withdraw;
    const cy = 326 - 92 * travel - 30 * Math.sin(travel * Math.PI) + 55 * withdraw + 5 * press;
    const ripple = clamp((t - 1.08) / .35);
    const ringOpacity = ripple > 0 && ripple < 1 ? .42 * (1 - ripple) : 0;
    const bellTime = Math.max(0, t - 1.65);
    const bellAngle = t < 1.65 ? 0 : 13 * Math.sin(bellTime * 24) * Math.exp(-bellTime * 7);
    const top = mix([246, 75, 73], [251, 249, 243], subscribed);
    const bottom = mix([204, 32, 43], [226, 224, 215], subscribed);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="540" viewBox="0 0 1536 540">
      <defs>
        <linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
        <filter id="shadow" x="-10%" y="-30%" width="120%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
        <filter id="cursorShadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
        <clipPath id="buttonClip"><rect x="255" y="90" width="1026" height="236" rx="48"/></clipPath>
      </defs>
      <g opacity="${opacity}" transform="translate(0 ${12 * (1 - enter) - 12 * exit})">
        <g transform="translate(768 208) scale(${scale}) translate(-768 -208)">
          <rect x="260" y="${104 - 4 * press}" width="1016" height="230" rx="48" fill="#15151a" opacity="${.24 - .08 * press}" filter="url(#shadow)"/>
          <rect x="255" y="90" width="1026" height="236" rx="48" fill="url(#face)"/>
          <rect x="257" y="92" width="1022" height="232" rx="46" fill="none" stroke="white" stroke-opacity=".24" stroke-width="3"/>
          <path d="M304 93h928" stroke="white" stroke-opacity=".25" stroke-width="2" stroke-linecap="round"/>
          <g clip-path="url(#buttonClip)"><circle cx="920" cy="234" r="${12 + 115 * ripple}" fill="none" stroke="white" stroke-width="5" opacity="${ringOpacity}"/></g>
          <g opacity="${oldLabel}" fill="white">
            <rect x="365" y="171" width="104" height="74" rx="20" fill="white" fill-opacity=".16"/>
            <path d="M405 188v40l34-20z"/>
            <text x="810" y="238" text-anchor="middle" font-family="Subscribe" font-weight="700" font-size="86" letter-spacing="1">SUBSCRIBE</text>
          </g>
          <g opacity="${newLabel}" fill="none" stroke="#375c51" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="404" cy="208" r="37" stroke-opacity=".18" stroke-width="4"/>
            <path d="m384 207 14 15 29-31" stroke-width="9" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - phase(t, 1.45, 1.8)}"/>
            <text x="790" y="235" text-anchor="middle" fill="#35423b" stroke="none" font-family="Subscribe" font-weight="700" font-size="74" letter-spacing=".5">SUBSCRIBED</text>
            <g transform="translate(1158 189) rotate(${bellAngle})" stroke="#687168" stroke-width="6">
              <path d="M-24 42h48l-7-10V13a17 17 0 0 0-34 0v19zM-7 51a7 7 0 0 0 14 0M0-6v-6"/>
            </g>
          </g>
        </g>
        <g opacity="${cursorOpacity}" transform="translate(${cx} ${cy}) scale(${1 - .04 * press})">
          <path d="M0 0v77l20-19 17 34 16-8-17-33h29z" transform="translate(3 5)" fill="#10161e" opacity=".3" filter="url(#cursorShadow)"/>
          <path d="M0 0v77l20-19 17 34 16-8-17-33h29z" fill="#fffefa" stroke="#25313b" stroke-width="5" stroke-linejoin="round"/>
        </g>
      </g></svg>`;
    await page.locator('main').evaluate((node, markup) => { node.innerHTML = markup; }, svg);
    await page.screenshot({ path: path.join(temp, `frame-${String(frame).padStart(3, '0')}.png`), omitBackground: true });
  }
  const encoded = path.join(temp, 'subscribe.mov');
  run(['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '30', '-i', path.join(temp, 'frame-%03d.png'), '-frames:v', '120', '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', encoded]);
  // Same-filesystem replacement is not guaranteed for a caller-selected TMPDIR.
  const { copyFile } = await import('node:fs/promises');
  await copyFile(encoded, `${output}.partial`);
  await rename(`${output}.partial`, output);
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
