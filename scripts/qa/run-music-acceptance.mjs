import { randomBytes, createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = join(root, "test-artifacts", "music-acceptance");
const fail = (message) => { console.error(`BLOCKED: ${message}`); process.exit(2); };
if (process.env.S6_MUSIC_ACCEPTANCE !== "1") fail("set S6_MUSIC_ACCEPTANCE=1 to explicitly authorize the isolated real-render acceptance run");
if (process.env.S6_TEST_TRANSCRIPT_JSON) fail("S6_TEST_TRANSCRIPT_JSON is forbidden: real acceptance must transcribe authorized sung vocals");
const source = process.env.S6_MUSIC_SOURCE && resolve(process.env.S6_MUSIC_SOURCE);
const attribution = process.env.S6_MUSIC_ATTRIBUTION?.trim();
const license = process.env.S6_MUSIC_LICENSE?.trim();
const modelCache = process.env.S6_MUSIC_MODEL_CACHE && resolve(process.env.S6_MUSIC_MODEL_CACHE);
if (!source) fail("S6_MUSIC_SOURCE must name an authorized human-sung vocal recording; synthetic/generated singing is not acceptable");
if (basename(source).toLowerCase() !== "scarborough_fair.ogg") fail("the live-transcription acceptance asserts Scarborough Fair lyric words and therefore requires the specifically attributed Scarborough_Fair.ogg test recording");
if (!attribution || !license) fail("provide S6_MUSIC_ATTRIBUTION and S6_MUSIC_LICENSE so attribution and license evidence can be retained");
if (!modelCache) fail("S6_MUSIC_MODEL_CACHE must name a locally cached Music Whisper model directory (no model download in this gate)");
for (const [label, file] of [["vocal source", source], ["model cache", modelCache]]) {
  try { await access(file); } catch { fail(`${label} is unavailable: ${file}`); }
}
async function hasModelWeights(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "model.bin") return true;
    if (entry.isSymbolicLink() && entry.name === "model.bin") {
      try { if ((await stat(join(directory, entry.name))).isFile()) return true; } catch { /* unresolved cache links are not usable weights */ }
    }
    if (entry.isDirectory() && await hasModelWeights(join(directory, entry.name))) return true;
  }
  return false;
}
if (!await hasModelWeights(modelCache)) fail(`S6_MUSIC_MODEL_CACHE has no cached Faster-Whisper model.bin: ${modelCache}`);
const image = process.env.S6_MUSIC_ENGINE_IMAGE;
const webImage = process.env.S6_MUSIC_WEB_IMAGE;
if (!image || !webImage) fail("set explicit locally built S6_MUSIC_ENGINE_IMAGE and S6_MUSIC_WEB_IMAGE tags; owner deployment images are never defaults");
if (image === "s6-cut-engine" || webImage === "s6-cut-web") fail("owner deployment image tags are forbidden; use uniquely tagged branch images");
for (const [label, tag] of [["engine", image], ["web", webImage], ["pot-provider", "brainicism/bgutil-ytdlp-pot-provider:2.0.2-deno"]]) {
  const imageCheck = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
  if (imageCheck.status !== 0) fail(`${label} image ${tag} is not locally built/cached; this runner does not build or pull images`);
}
const serifFont = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "fc-match", image, "-f", "%{family}\\n%{file}\\n", "Lora"], { encoding: "utf8" });
if (serifFont.status !== 0 || !/^Lora/m.test(serifFont.stdout) || !serifFont.stdout.includes("/lora/Lora.ttf")) fail(`cached engine image cannot resolve the bundled Lora serif face (${serifFont.stdout?.trim() || serifFont.stderr?.trim()})`);
const robotoCondensed = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "fc-match", image, "-f", "%{family}\\n%{style}\\n%{file}\\n", "Roboto Condensed:style=Light"], { encoding: "utf8" });
if (robotoCondensed.status !== 0 || !/^Roboto Condensed/m.test(robotoCondensed.stdout) || !/^Light$/m.test(robotoCondensed.stdout) || !robotoCondensed.stdout.includes("/roboto_condensed/RobotoCondensed-Light.ttf")) fail(`cached engine image cannot resolve the exact bundled Roboto Condensed Light face (${robotoCondensed.stdout?.trim() || robotoCondensed.stderr?.trim()})`);
const bodoniModa = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "fc-match", image, "-f", "%{family}\\n%{file}\\n", "Bodoni Moda"], { encoding: "utf8" });
if (bodoniModa.status !== 0 || !/^Bodoni Moda/m.test(bodoniModa.stdout) || !bodoniModa.stdout.includes("/bodoni_moda/BodoniModa-Variable.ttf")) fail(`cached engine image cannot resolve the exact bundled Bodoni Moda variable face (${bodoniModa.stdout?.trim() || bodoniModa.stderr?.trim()})`);
const ffmpeg = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "ffmpeg", image, "-version"], { stdio: "ignore" });
if (ffmpeg.status !== 0) fail(`isolated engine image ${image} does not provide FFmpeg for fixture creation and media inspection`);
const probe = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "ffprobe", image, "-version"], { stdio: "ignore" });
if (probe.status !== 0) fail(`isolated engine image ${image} does not provide FFprobe for media inspection`);

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}
async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}
function makeDataRemovable(directory) {
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--volume", `${directory}:/data:rw`, "--entrypoint", "sh", image, "-lc", "for entry in /data/* /data/.[!.]*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; chmod -R a+rwX \"$entry\" 2>/dev/null || true; done"], { encoding: "utf8" });
  if (result.status !== 0) console.error(`could not make isolated test data removable (${result.stderr?.trim() || result.stdout?.trim() || result.error?.message})`);
}
async function healthy(url) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${url}/healthz`); if (response.ok) return; } catch { /* wait on service readiness */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`isolated gateway readiness timed out: ${url}`);
}

await mkdir(artifacts, { recursive: true });
await chmod(artifacts, 0o777);
const fixture = join(artifacts, "music-testsrc-with-authorized-vocals.mp4");
const record = join(artifacts, "source-attribution-license.json");
await writeFile(record, JSON.stringify({ sourcePath: source, sha256: createHash("sha256").update(await readFile(source)).digest("hex"), attribution, license, sourceUse: "authorized human-sung vocals; original audio stream is used as the fixture soundtrack", transcriptEvidence: "none; fixture video is not speech/transcription evidence" }, null, 2));
const fixtureContainerPath = "/qa/music-testsrc-with-authorized-vocals.mp4";
const dockerMedia = ["run", "--rm", "--network", "none", "--volume", `${artifacts}:/qa:rw`, "--volume", `${dirname(source)}:/source:ro`, "--entrypoint"];
await run("docker", [...dockerMedia, "ffmpeg", image, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=65", "-i", `/source/${source.split(/[\\/]/).at(-1)}`, "-map", "0:v:0", "-map", "1:a:0", "-t", "65", "-vf", "drawbox=x='mod(t*90,1100)':y=300:w=180:h=120:color=0x00d4ff:t=fill,drawbox=x=20:y=20:w=420:h=12:color=0xffcc00:t=fill", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", fixtureContainerPath]);
const inspected = spawnSync("docker", [...dockerMedia, "ffprobe", image, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", fixtureContainerPath], { encoding: "utf8" });
if (inspected.status !== 0 || !inspected.stdout.includes("audio")) fail("authorized source must contain a readable audio stream; no synthetic audio will be substituted");
const fontFixture = join(artifacts, "music-font-resolution.ass");
await writeFile(fontFixture, `[Script Info]\nScriptType: v4.00+\nPlayResX: 128\nPlayResY: 128\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: LegacySerif,Lora,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1\nStyle: ReferenceSans,Roboto Condensed,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,5,0,0,0,1\nStyle: ReferenceSerif,Bodoni Moda,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,5,0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:00.10,LegacySerif,,0,0,0,,Music font check\nDialogue: 0,0:00:00.00,0:00:00.10,ReferenceSans,,0,0,0,,Music font check\nDialogue: 0,0:00:00.00,0:00:00.10,ReferenceSerif,,0,0,0,,Music font check\n`);
const fontRender = spawnSync("docker", [...dockerMedia, "ffmpeg", image, "-hide_banner", "-loglevel", "debug", "-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.2", "-vf", "subtitles=/qa/music-font-resolution.ass", "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
const fontLog = `${fontRender.stdout || ""}\n${fontRender.stderr || ""}`;
if (fontRender.status !== 0 || !/fontselect: \(Lora, 400, 0\) -> \/.*\/lora\/Lora\.ttf, \d+, Lora/i.test(fontLog)) fail(`libass did not resolve the bundled Lora face in the production engine image (${fontLog.slice(-2000)})`);
if (!/fontselect: \(Roboto Condensed, 400, 0\) -> \/.*\/roboto_condensed\/RobotoCondensed-Light\.ttf, \d+, RobotoCondensed-Light/i.test(fontLog)) fail(`libass did not resolve Roboto Condensed Light in the production engine image (${fontLog.slice(-2000)})`);
if (!/fontselect: \(Bodoni Moda, 400, 0\) -> \/.*\/bodoni_moda\/BodoniModa-Variable\.ttf, \d+, BodoniModa-Regular/i.test(fontLog)) fail(`libass did not resolve Bodoni Moda at regular weight in the production engine image (${fontLog.slice(-2000)})`);

const webPort = await freePort();
const enginePort = await freePort();
if (webPort === 8080 || enginePort === 8001 || webPort === enginePort) fail("allocated ports collide with owner defaults or each other; rerun for fresh isolated ports");
const project = `s6-music-${process.pid}-${randomBytes(5).toString("hex")}`;
const data = await mkdtemp(join(artifacts, "data-"));
await chmod(data, 0o777);
const modelData = join(data, "models");
await mkdir(modelData, { recursive: true });
await chmod(modelData, 0o777);
const cacheCopy = spawnSync("docker", ["run", "--rm", "--network", "none", "--volume", `${modelCache}:/source:ro`, "--volume", `${modelData}:/destination:rw`, "--entrypoint", "sh", image, "-lc", "set -eu; trap 'for entry in /destination/* /destination/.[!.]*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; chmod -R a+rwX \"$entry\" 2>/dev/null || true; done' EXIT; for entry in /source/* /source/.[!.]*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; name=\"${entry##*/}\"; case \"$name\" in .agent_harnesses.json|xet) continue;; esac; cp -a \"$entry\" /destination/; done; for entry in /destination/* /destination/.[!.]*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; chmod -R a+rwX \"$entry\"; done"], { encoding: "utf8" });
if (cacheCopy.status !== 0) {
  await rm(data, { recursive: true, force: true });
  fail(`isolated engine container could not copy the locally cached Whisper model (${cacheCopy.stderr?.trim() || cacheCopy.stdout?.trim()})`);
}
const override = join(artifacts, `${project}.compose.yaml`);
await writeFile(override, `services:\n  engine:\n    image: ${image}\n  web:\n    image: ${webImage}\n`);
const url = `http://127.0.0.1:${webPort}`;
const env = { ...process.env, S6_PORT: `127.0.0.1:${webPort}`, S6_ENGINE_PORT: String(enginePort), S6_DATA_PATH: data, S6_MUSIC_ACCEPTANCE_URL: url, S6_MUSIC_FIXTURE: fixture, S6_MUSIC_ENGINE_IMAGE: image, S6_WHISPER_MODEL: process.env.S6_WHISPER_MODEL || "small", S6_MUSIC_WHISPER_MODEL: process.env.S6_MUSIC_WHISPER_MODEL || "small" };
const compose = ["compose", "-p", project, "-f", join(root, "compose.yaml"), "-f", override];
let up = false;
try {
  up = true;
  await run("docker", [...compose, "up", "-d", "--no-build"], { env });
  await healthy(url);
  const fullSuite = env.S6_MUSIC_FULL_SUITE === "1";
  const testArgs = fullSuite ? [] : ["--", "tests/acceptance/music-presentation-real.spec.ts"];
  await run("npm", ["run", "test:acceptance", ...testArgs], { env: { ...env, S6_ACCEPTANCE_URL: url, S6_PLAYWRIGHT_ARTIFACTS: join(artifacts, "playwright"), S6_MUSIC_ARTIFACTS: artifacts, S6_MUSIC_SOURCE: source } });
} catch (error) {
  console.error(`BLOCKED/FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (up) {
    try { await run("docker", [...compose, "logs", "--no-color"], { env, stdio: "inherit" }); } catch { /* logs retained when available */ }
    try { await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { env }); } catch (error) { console.error(`isolated Compose teardown failed: ${error.message}`); process.exitCode = 1; }
  }
  makeDataRemovable(data);
  await rm(data, { recursive: true, force: true });
  await rm(override, { force: true });
}
