import { test } from 'vitest';
import assert from 'node:assert/strict';
import { clipDownloadName } from './clipFilename.js';

test('uses the AI title as the filename', () => {
  assert.equal(
    clipDownloadName({ video_title_for_youtube_short: 'My Viral Moment' }, 0),
    'My Viral Moment.mp4',
  );
});

test('strips Windows-forbidden characters', () => {
  assert.equal(
    clipDownloadName({ video_title_for_youtube_short: 'A<b>:c"/d\\e|f?g*h' }, 0),
    'A b c d e f g h.mp4',
  );
});

test('removes control characters', () => {
  assert.equal(
    clipDownloadName({ video_title_for_youtube_short: 'tab\there\nnewline' }, 0),
    'tab here newline.mp4',
  );
});

test('trims trailing dots and spaces', () => {
  assert.equal(
    clipDownloadName({ video_title_for_youtube_short: 'Hello world...  ' }, 0),
    'Hello world.mp4',
  );
});

test('falls back to clip_N when title is empty', () => {
  assert.equal(clipDownloadName({ video_title_for_youtube_short: '' }, 2), 'clip_3.mp4');
  assert.equal(clipDownloadName({}, 0), 'clip_1.mp4');
  assert.equal(clipDownloadName(null, 4), 'clip_5.mp4');
});

test('falls back when title is only forbidden chars', () => {
  assert.equal(clipDownloadName({ video_title_for_youtube_short: '???' }, 0), 'clip_1.mp4');
});

test('dodges Windows reserved device names', () => {
  assert.equal(clipDownloadName({ video_title_for_youtube_short: 'CON' }, 0), 'clip_1.mp4');
  assert.equal(clipDownloadName({ video_title_for_youtube_short: 'com1' }, 1), 'clip_2.mp4');
  // A reserved word as part of a longer title is fine.
  assert.equal(clipDownloadName({ video_title_for_youtube_short: 'CONtext' }, 0), 'CONtext.mp4');
});

test('caps overly long titles at 120 chars', () => {
  const longTitle = 'x'.repeat(200);
  const out = clipDownloadName({ video_title_for_youtube_short: longTitle }, 0);
  assert.equal(out, `${'x'.repeat(120)}.mp4`);
});

test('honours a custom extension', () => {
  assert.equal(
    clipDownloadName({ video_title_for_youtube_short: 'clip' }, 0, 'mov'),
    'clip.mov',
  );
});
