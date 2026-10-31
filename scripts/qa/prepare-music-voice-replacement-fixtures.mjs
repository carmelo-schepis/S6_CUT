#!/usr/bin/env node
/** Stage isolated real-media inputs for verify-music-voice-replacement.mjs.
 * All media stems must come from the same human-narrated source. This script
 * does not create transcript data, alter the mixed source, or inject a model. */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const required = {
  output: 'S6_MUSIC_VOICE_FIXTURES',
  source: 'S6_MUSIC_VOICE_SOURCE',
  sourceOffset: 'S6_MUSIC_VOICE_SOURCE_OFFSET_SECONDS',
  voice: 'S6_MUSIC_VOICE_VOICE_STEM',
  originalMusic: 'S6_MUSIC_VOICE_MUSIC_STEM',
  replacement: 'S6_MUSIC_VOICE_REPLACEMENT',
  speechStart: 'S6_MUSIC_VOICE_SPEECH_WINDOW_START',
  speechDuration: 'S6_MUSIC_VOICE_SPEECH_WINDOW_DURATION',
  lateStartMin: 'S6_MUSIC_VOICE_LATE_START_MIN',
  replacementFrequency: 'S6_MUSIC_VOICE_REPLACEMENT_FREQUENCY_HZ',
};
const values = Object.fromEntries(Object.entries(required).map(([key, name]) => [key, process.env[name]]));
for (const [key, value] of Object.entries(values)) if (!value) throw new Error(`Set ${required[key]} before staging the real media fixtures.`);
if (!process.env.TMUX) throw new Error('Run fixture preparation inside tmux on linuxpc.');
const output = resolve(values.output);
if (output === '/' || output.startsWith('/app/data/') || output === '/app/data') throw new Error('Fixture output must be a disposable QA directory, not production application data.');
const sourceOffset = Number(values.sourceOffset), speechStart = Number(values.speechStart), speechDuration = Number(values.speechDuration), lateStartMin = Number(values.lateStartMin), replacementFrequencyHz = Number(values.replacementFrequency);
if (![sourceOffset, speechStart, speechDuration, lateStartMin, replacementFrequencyHz].every(Number.isFinite) || sourceOffset < 0 || speechStart < lateStartMin || speechDuration <= 0 || lateStartMin < 0 || replacementFrequencyHz <= 0) throw new Error('Source offset, speech window, late clip minimum, and replacement frequency must be valid positive numbers.');

await mkdir(output, { recursive: true });
const files = {
  'voice-reference.wav': resolve(values.voice),
  'original-music-reference.wav': resolve(values.originalMusic),
  'replacement.mp3': resolve(values.replacement),
};
for (const [name, source] of Object.entries(files)) await cp(source, join(output, name));

const engineImage = process.env.S6_MUSIC_VOICE_ENGINE_IMAGE || 's6-cut-engine-authenticity-fixture:latest';
function mediaTool(tool, args, sourcePath) {
  const mounts = ['-v', `${output}:/qa:rw`];
  if (sourcePath) mounts.push('-v', `${resolve(sourcePath)}:/input/source:ro`);
  return execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--memory=3g', '--memory-swap=4g', '--cpus=3', ...mounts,
    '--entrypoint', tool, engineImage, ...args,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function probe(file, sourcePath) {
  const path = sourcePath ? '/input/source' : `/qa/${file}`;
  return JSON.parse(mediaTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], sourcePath));
}
const fullSourceProbe = probe('', resolve(values.source));
const voiceDuration = Number(probe('voice-reference.wav').format.duration);
const musicDuration = Number(probe('original-music-reference.wav').format.duration);
if (Math.abs(voiceDuration - musicDuration) > 0.1) throw new Error('Voice and original-music reference stems must align and have matching durations.');
const stemDuration = Math.min(voiceDuration, musicDuration);
if (sourceOffset + stemDuration > Number(fullSourceProbe.format.duration)) throw new Error('The source offset plus clean-stem duration exceeds source media duration.');
mediaTool('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(sourceOffset), '-i', '/input/source', '-t', String(stemDuration),
  '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '/qa/source.mp4',
], resolve(values.source));
const sourceProbe = probe('source.mp4');
const sourceDuration = Number(sourceProbe.format.duration);
if (!sourceProbe.streams.some(stream => stream.codec_type === 'video') || !sourceProbe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('The source MP4 must contain video and mixed narration/music audio.');
if (speechStart + speechDuration > sourceDuration || lateStartMin + 10 > sourceDuration) throw new Error('Speech window or late-start boundary exceeds the source video duration.');
for (const name of ['voice-reference.wav', 'original-music-reference.wav']) {
  if (!probe(name).streams.some(stream => stream.codec_type === 'audio')) throw new Error(`${name} has no decodable audio stream.`);
}
if (!probe('replacement.mp3').streams.some(stream => stream.codec_type === 'audio')) throw new Error('replacement.mp3 has no decodable audio stream.');

// Preserve the exact source video while providing a second source with the
// human voice stem and no source accompaniment. This is used to exercise the
// 0% replacement gain path. The real replacement job still uploads source.mp4.
mediaTool('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', '/qa/source.mp4', '-i', '/qa/voice-reference.wav',
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '/qa/voice-only.mp4',
]);
const voiceOnlyProbe = probe('voice-only.mp4');
if (!voiceOnlyProbe.streams.some(stream => stream.codec_type === 'video') || !voiceOnlyProbe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('Could not create a valid voice-only source MP4.');
// A valid six-channel source reaches the separator, which must return a clear
// unsupported-input error rather than quietly keeping the original music.
mediaTool('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', '/qa/source.mp4',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=5.1:d=12', '-t', '12',
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
  '-c:a', 'aac', '-ac', '6', '-shortest', '/qa/separation-failure.mp4',
]);
const separationFailureProbe = probe('separation-failure.mp4');
if (separationFailureProbe.streams.find(stream => stream.codec_type === 'audio')?.channels !== 6) throw new Error('Could not create the six-channel separation-failure fixture.');
await writeFile(join(output, 'source-probe.json'), JSON.stringify(sourceProbe, null, 2));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const manifest = {
  schema: 1,
  source: { filename: 'source.mp4', sha256: await hash(join(output, 'source.mp4')), sourceOffsetSeconds: sourceOffset, durationSeconds: sourceDuration, humanNarrationAndMusic: true },
  voiceStem: { filename: 'voice-reference.wav', sha256: await hash(join(output, 'voice-reference.wav')) },
  originalMusicStem: { filename: 'original-music-reference.wav', sha256: await hash(join(output, 'original-music-reference.wav')) },
  replacement: { filename: 'replacement.mp3', sha256: await hash(join(output, 'replacement.mp3')), metricFrequencyHz: replacementFrequencyHz },
  speechWindow: { start: speechStart, duration: speechDuration },
  lateStartMin,
  metrics: {
    voiceRmsFloor: 0.008,
    replacementToneFloor: 0.004,
    voiceStemCorrelationFloor: 0.15,
    originalMusicStemCorrelationMaxAbs: 0.35,
    note: 'Thresholds are declared in the acceptance test before tuning and are not configurable at run time.',
  },
};
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ fixtureDirectory: output, files: Object.keys(files).concat(['voice-only.mp4', 'source.mp4', 'source-probe.json', 'manifest.json']), sourceOffsetSeconds: sourceOffset, sourceDurationSeconds: sourceDuration, speechWindow: manifest.speechWindow, lateStartMin, replacementFrequencyHz }, null, 2));
