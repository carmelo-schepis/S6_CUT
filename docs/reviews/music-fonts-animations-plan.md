# Music typography, lyric transitions, and hook banner

Diagnosis and implementation plan, 2026-10-22. Baseline: `4ac49ce` on `origin/main`.
Scope: **Music mode only**. This deliverable is a plan; the features below are
proposed, not implemented.

Working branch: `plan/music-typography-transitions-20261022` in
`/home/linuxpc/git_branches/S6_CUT-music-typography-plan`. A similarly named
`S6_CUT-music-fonts-animations` worktree already existed, so a distinct branch was
created to avoid taking over another agent's work. Implementation must also use a
worktree under `/home/linuxpc/git_branches`; keep `/home/linuxpc/Git_projects/S6_CUT`
on `main`.

## Diagnosis

Music already has six themes: Clean sans, Warm highlight, Soft serif, Reference
white sans, Reference yellow sans, and Reference white serif. Their font families
are Barlow, Lora, Roboto Condensed Light, and Bodoni Moda. The theme cards in
`web/src/components/projects-view.tsx` are static samples. There is no Music lyric
animation selector or hook-format selector.

`MusicPresentationConfig` in `engine/models.py` currently accepts only
`version: 1` and `subtitleTheme`. Its HTTP counterpart is
`musicPresentationSchema` in `web/src/types.ts`. Creation submits the config as
the `music_presentation` JSON form field; the API saves it on the Job and in the
private job checkpoint. Music hook text is the existing manual `musicTopText`
field, limited to 100 characters and gated by the Hook text checkbox. It is
separate from Speech's `hookText`/automatic hook generation.

The missing slow animation is a renderer issue, not a missing CSS transition:

- Legacy Music themes emit a copy of the lyric group for each word interval.
  There is no opacity transition, and small gaps between words can leave gaps
  between rendered events.
- `_reference_music_groups` groups by punctuation, a pause over 0.65 seconds,
  and a fixed word count. `_reference_music_events` positions separate rows, but
  all rows share the phrase start/end. Its `\\kt`/`\\k` karaoke tags use identical
  primary and secondary colours. Words therefore do not visibly reveal in time;
  a whole block is already visible at phrase onset.
- None of these Music lyric events contains `\\fad`, `\\fade`, or `\\t` opacity
  animation. This was confirmed by calling production `write_music_ass` for
  Clean and all three reference themes with deterministic timed words.
- `MusicTop` is currently one static white Barlow event over the full clip.
  There is no white backing rectangle or measured banner layout.

The initial render and caption-edit rerender both obtain Music options through
`_music_render_kwargs` in `engine/jobs.py`. Both `render_clip` and
`render_fast_clip` must receive new options. Here `render_fast_clip` is also used
as a source-only caption-rerender adapter; its name does not mean the Music job
was changed to Fast processing.

Existing image goldens verify six themes on four canvases, but a single frame
cannot prove a fade or the absence of a flash at a phrase boundary. The existing
soundtrack acceptance also covers restart, caption edits, playback, and exports;
it is a useful integration base.

## Reference observations

All four references were opened and played in Chromium, with frames sampled
after seeking. The first reference was also decoded from a local MP4. Font
identities below are visual candidates, not claims about the creators' fonts.

1. [Condensed lyric build](https://www.youtube.com/shorts/nt2hXBfkKiw): a square
   white canvas with black, narrow sans lettering. Words accumulate over several
   seconds in a stable, loosely spaced block. The whole sentence is not visible
   at the beginning. Samples from 0.5–10.8 seconds show this build clearly. This
   clip is stronger evidence for typography and gradual word reveal than for a
   particular crossfade duration. Do not interpret its white background as a
   request to replace the user's footage.
2. [Handwritten vertical lyrics](https://www.youtube.com/shorts/WRP2nvtdOZw):
   small white, rounded handwritten lettering over night footage. Words form a
   narrow vertical stack and accumulate in time. Around 3.8–4.8 seconds, outgoing
   letters break into a textured dissolve while a lower line remains. This is
   visibly more than a uniform opacity fade. Start with the requested smooth
   fade/build; an exact distressed dissolve is a separate optional follow-up.
3. [Condensed lyrics over footage](https://www.youtube.com/shorts/t1W5GDPMIHM):
   black condensed sans text over a central video band with black outer margins.
   The first lyric block appears around 5 seconds, grows through 10 seconds,
   and is replaced by a new block by 12 seconds. The first few seconds have no
   lyric text. Preserve such instrumental gaps rather than inventing text.
4. [White hook banner](https://www.youtube.com/shorts/JAIE4AKApzA): black,
   centred sans text wraps to two lines on a full-width white strip immediately
   above the footage. The banner remains stable across shot changes in samples
   from 0.5–12 seconds. Its formatting belongs to Music's optional manual hook;
   no new automatic hook writer or hook animation is needed.

Inspection evidence is local and ignored under
`.qa/music-text-references/` in the planning worktree: four
`<video-id>-browser-contact.jpg` contact sheets, individual browser samples,
clean video-pixel crops named `<video-id>-clean-<seconds>.png` for references
1–3, the first MP4, and `baseline-<theme>.ass` diagnostic outputs. Keep downloaded
reference media out of Git and the shipped app. These are visual references,
not transcription fixtures or redistributable product assets.

Native preview returned: `Preview automation open failed: This host blocks the
sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+).` The fallback used the
already installed Playwright Chromium with its own temporary browser context.
Three direct yt-dlp downloads returned HTTP 403; browser playback and frame
extraction succeeded. No production browser profile, database, job, or service
was changed.

## Proposed user controls

Retain all six existing theme choices and add three Music themes:

- **Condensed black** (`condensed_black`): a new narrow sans face and black
  lettering, inspired by references 1 and 3. Recommend Oswald Regular as the
  first comparison candidate, fitted to the existing footage region.
- **Condensed white** (`condensed_white`): the same new face in white, giving
  users a legible option for dark footage.
- **Handwritten stack** (`handwritten_stack`): white Gaegu Bold as the initial
  visual-fit candidate for reference 2, with a bounded vertical stack.

Add a separate **Lyric animation** selector so users can combine typography and
motion: **Original**, **Slow fade**, **Line crossfade**, and **Word build**.
Original preserves today's behaviour and remains the default. Recommend Line
crossfade for the user's slow line-to-line request and Word build for the
accumulating references. New themes must also work with Original.

Inside Music's existing checked Hook text section, retain Top text and add
**Hook text format** with **Plain** and **White banner**. Plain stays the default;
White banner uses black text on white and the user's exact manual content.
Keep the 100-character limit and off-by-default checkbox. A blank or unchecked
hook must produce neither text nor an empty white rectangle. Hook formatting
must be independent of lyric font and animation.

Use local sample previews, including a short replayable animation example and a
white-banner sample. Respect reduced motion by presenting a still preview and
an explicit Play control. CSS previews demonstrate the setting; final acceptance
must inspect an actual FFmpeg render. On mode switches, Music choices may remain
in component state but must never be serialized into Speech submissions.

## Contract and persistence

Make additive changes to `MusicPresentationConfig` and its Zod mirror. Keep
`version: 1`; add the new named subtitle themes and optional fields:

```json
{
  "version": 1,
  "subtitleTheme": "handwritten_stack",
  "lyricAnimation": "line_crossfade",
  "hookTextFormat": "white_banner"
}
```

Allowed `lyricAnimation` values: `legacy`, `slow_fade`, `line_crossfade`,
`word_build`. Allowed `hookTextFormat` values: `plain`, `white_banner`.
Represent omitted new fields as optional/null internally and resolve them to
legacy/plain at the rendering boundary. Preserve the existing two-field public
config shape when the caller omitted new fields; do not add default keys to
historical responses merely by reading them. Continue rejecting unknown fields
and invalid enum values. Match snake_case storage and camelCase HTTP names.

Save the full config in the existing Job/private snapshot rather than adding
separate unrelated request fields or a database migration. Copy the snapshot
wherever jobs are cloned/retried. Completed MP4s retain their existing bytes;
new choices take effect on new renders. Caption edits on a job must use its
saved typography, motion, and hook format after restart/retention recovery.

Extend `_music_render_kwargs`, `render_clip`, `render_fast_clip`, `write_ass`,
and `write_music_ass` coherently. Keep new arguments keyword-only with legacy
defaults and preserve compatibility adapters. Gate dispatch on the Music
profile/presentation, so a Speech job cannot accidentally enter the new path.
The API must reject Music-only presentation requests for Speech as it does now.

Show the resolved choices read-only in Music Workspace details. Add the Music
presentation and top text to export metadata using additive keys; preserve the
ZIP manifest schema and the existing files. MP4 preview/download/ZIP must use
the same published video. SRT/VTT remain text and timing sidecars; they cannot
represent these font/animation/banner treatments. An optional plain subtitle
track must not be described as an animated ASS equivalent.

## Timing and rendering design

Add a Music-only layout/timeline helper, preferably a small module such as
`engine/music_typography.py`, rather than expanding Speech grouping rules.
Feed it clip-local words from `caption_words_for_clip`. Determine stable lyric
blocks once, using punctuation, pauses, maximum measured width, maximum rows,
and a bounded duration. Keep references to every original word and its timing.
Do not reflow already visible words whenever a new word arrives, and do not
hard-code a particular song's sentence or spacing.

For the new animation path, define these initial tuning values explicitly:

- Slow fade: 450 ms fade-in, 650 ms fade-out, with a readable hold in between.
  Clamp both to short block lifetimes and leave at least 40% fully readable.
- Line crossfade: incoming block starts fading in at its first word's onset.
  Outgoing block fades away over a nominal 600 ms from that same point. This
  requires overlapping events; two `\\fad` tags on non-overlapping events only
  fade through an empty frame. Never reveal incoming words before their onset.
  Cap overlap using adjacent block durations and the following onset, allowing
  at most two blocks at a time.
- Word build: reveal each word at its real onset with an approximately 180 ms
  opacity ramp, retain earlier words in fixed positions, then fade the completed
  block out over approximately 500 ms. Clamp ramps for fast words.
- End-of-phrase hold: permit up to 800 ms when needed for readability, bounded
  by the next block. Across a long instrumental gap (initial proposal: over
  1.2 s), fade the old block out and leave silence visually empty. At the end of
  a clip, clamp everything to the real duration.

These numbers are proposed defaults, not measurements of the reference clips.
Tune them using decoded transition frames and a short visual comparison.
Timestamp adjustments affect only display envelopes; never rewrite transcript
word times, caption-editor cues, song speed, audio, or planning windows.

Use ASS opacity transforms/events supported by the shipped libass. Avoid
per-frame Python rendering and browser-only export effects. For crossfades,
give old/new blocks a deterministic order and verify opacity between them;
static position changes must not make an apparent jump at the transition.
The exact textured dissolve in reference 2 is outside this first delivery;
do not label a plain opacity fade as an exact recreation of it.

Measure text with the actual bundled face, accounting for libass font-height
metrics, and fit both width and height. A vertical stack must paginate or shrink
within a documented minimum rather than extend off-screen or lose words.
Long words, apostrophes, punctuation, explicit clip cuts, and very short cues
must remain valid. Keep the old rendering path unchanged when animation is
omitted/legacy; existing goldens must not need regeneration for this addition.

## Font delivery and hook geometry

Use the existing local font packaging pattern. Pin each upstream source commit,
record SHA-256/provenance/license, place engine faces under `engine/fonts/`, and
ship matching preview files under `web/public/fonts/`. Extend
`THIRD_PARTY_NOTICES.md` and `third_party_provenance.json`. Google Fonts currently
provides [Gaegu static faces](https://github.com/google/fonts/tree/main/ofl/gaegu)
and [Oswald variable source](https://github.com/google/fonts/tree/main/ofl/oswald).
Their directory contents were verified through GitHub's API during diagnosis.
For Oswald, generate and document a deterministic static Regular instance with
build-time tooling, then vendor that result; avoid runtime font downloads or
unverified variable-axis selection in libass. Confirm the visible candidate
against the reference before locking it in.

Do not add a regular Roboto Condensed face casually: today's reference themes
request the family at nominal weight 400 but resolve to the sole installed
Light face. Adding a Regular face under that family can silently change all
existing reference renders. Separate new families avoid that regression.
Extend font-resolution diagnostics to cover the new exact faces and verify
libass's selected font file in the production image. Current startup checks
do not cover every Music family.

Render the white hook banner as an ASS vector rectangle beneath its text,
using existing Barlow as the initial locally bundled sans candidate. Place it
immediately above the fitted footage rectangle, within the available upper
black region. Derive that rectangle from the same geometry used by
`_music_source_layout_filter`, including source aspect and the existing upward
offset; do not guess from the 9:16 canvas centre or move/crop footage to fit it.
Use measured word wrapping, centred lines, inset padding, and bounded height.
Start with two lines, allow a measured third line for a long 100-character hook,
and reduce size within a readable minimum when necessary. Never truncate
silently. Escape ASS metacharacters and controls as the current renderer does.

Keep the banner stable for the clip, matching the fourth reference. Reserve
space for the existing subscription animation and creator credit; verify that
enabled overlays do not cover the hook. If there is insufficient room, fit the
text/banner within the available space with a documented fallback. Exercise
the renderer's existing square, landscape, and 4:5 support as well as the Music
creation UI's 9:16 default. Do not broaden Music format eligibility in this task.

## Staged prompts for GPT Luna

Run in order. At every stage, read this plan, `DO-NOT-CHANGE/AGENTS.md`, and the
current implementation first. Use one isolated implementation branch under
`/home/linuxpc/git_branches`, commit each completed stage, and record checks and
unresolved points in a local ledger. Reuse that branch for later stages. Do not
merge a partly wired selector into main.

### Prompt 1 — contract and fonts

Implement the proposed Music-only config fields and three themes in the
Pydantic/Zod/request/persistence contracts. Keep omitted settings and historical
two-field responses compatible. Preserve API rejection of Music settings on
Speech. Vendor pinned Oswald Regular and Gaegu Bold candidates with licenses,
checksums, provenance, and matching local web preview faces; verify exact
fontconfig/libass selection without changing any old theme's font. Add focused
schema/API/serialization/font tests. No UI selector should advertise a renderer
that does not exist yet. Commit and report validation.

### Prompt 2 — stable lyric timeline

Implement the Music-only block layout and display-envelope planner described
above. Define deterministic pause, duration, row, width, overlap, and fade bounds.
Preserve every timed word, keep earlier words fixed during word build, handle
instrumental gaps and clip-edge words, and leave legacy dispatch intact. Test
word preservation, no early incoming words, bounded overlaps, repeated lyrics,
short/long blocks, fast words, and nonzero clip offsets. Commit and report.

### Prompt 3 — rendered lyric motion

Wire the new fonts/layout/animation through both renderers and both initial and
caption-edit job paths. Render slow fade, genuine line crossfade, and word build
through production FFmpeg/libass. Keep audio/song-loop/speed/mix settings and
SRT/VTT word timings intact. Add small real-render transition fixtures; inspect
frames before, during, and after a boundary. Prove that a midpoint contains both
blocks for crossfade, that alpha changes progressively, and that word build
does not show future words. Keep all legacy Music and Speech goldens unchanged.
Commit the renderer plus evidence/check results.

### Prompt 4 — hook banner and complete controls

Implement the white Music hook banner with measured layout above the real fitted
footage region. Test blank/unchecked hooks, 100/101-character input, long words,
wrapping, escaping, source aspects, and subscription-animation collisions. Add
the three theme cards, independent Lyric animation selector and preview, and
Music-only Hook text format selector under the current checkbox. Preserve plain
defaults and prevent Music-to-Speech submission leaks. Show saved choices in
Workspace, add export metadata, and update Help/README. Test initial creation,
restart, and caption edits using the persisted options. Commit and report.

### Prompt 5 — acceptance and integration

Run the final gates below against isolated storage and ports. Resolve failed
checks and inspect decoded visual results before declaring success. Fetch latest
main and integrate other agents' changes on the implementation branch; rerun
affected checks after integration. Merge the completed, verified implementation
into main in `/home/linuxpc/Git_projects/S6_CUT`, keeping branch worktrees outside
that directory. Preserve unrelated working-tree files. Report the merge commit
and distinguish local merge, remote push, and deployment status. No production
rebuild or historical-output regeneration is implied by this plan.

## Completion gates

1. **Contracts and isolation:** old payloads load unchanged; invalid new enums
   fail; all new options survive job save/reload/retry and are absent from Speech
   submissions. Hook opt-in starts unchecked and an unchecked hook leaves no
   rectangle. Theme and animation are independent.
2. **Rendered motion:** inspect a fixture covering all three new themes and
   all three new animations, plus Original. Sample the first visible frame,
   steady hold, transition onset, 25/50/75% of the transition, transition end,
   instrumental gap, and clip end. Compare text-region pixels against the same
   background without text so changing footage cannot masquerade as fading.
   Keep deterministic ASS/MP4/frame evidence in ignored `.qa/`.
3. **Hook pixels and layout:** decode a real MP4 proving a white strip and black
   centred wrapped text above the footage, no covering of source content, and
   no empty strip when disabled. Verify readable long text and concurrent
   subscription animation. Visually review new goldens; never regenerate old
   goldens to conceal a regression.
4. **Integration:** create a real Music job through the UI, restart its isolated
   engine, edit a caption, and verify that font, motion, banner, and audio are
   retained. Check browser playback, standalone MP4, and ZIP content/metadata.
   Reuse the existing soundtrack runner where practical. Deterministic timed
   words are legitimate renderer evidence; separately label any real-vocal
   transcription check and never present a fixture transcript as Whisper proof.
5. **Regression:** run affected engine tests (`test_music_presentation.py`,
   `test_music_lifecycle.py`, `test_music_track_render.py`, `test_caption_fonts.py`,
   `test_caption_goldens.py`, `test_subtitles.py`, and new motion tests), frontend
   Music/API/schema/Workspace tests, and isolated Music acceptance. Run repository
   lint, provider checks, typecheck, full frontend and engine suites, and build
   before merging. Account for missing host media tools with the production
   image, not a claim that skipped visual checks passed.

## Planning validation

This diagnosis inspected the current models, API, Music controls, geometry,
caption writer, initial/rerender propagation, font resolution, export builder,
golden tests, and real Music acceptance runners. It sampled all four supplied
clips and generated baseline ASS with the actual current writer. Only this
documentation is changed; implementation tests and feature acceptance remain
future completion gates, not claimed results of this planning task.
