# Implementation prompt for GPT Luna: YouTube-inspired editing styles and subtitle previews

## Goal and workspace

Implement a useful library of selectable editing styles in S6_CUT. Users must be able to choose subtitle treatments, video filters, heading treatments, and optional emoji reactions, see representative previews before creating a project, and receive those effects in the rendered video.

Work in `/home/linuxpc/git_branches/S6_CUT-youtube-editing-style-library-20261030`, branch `plan/youtube-editing-style-library-20261030`. This worktree was created from `origin/main` at `1fb5497`. Reinspect its current state before editing; other work may have landed since planning. Keep `/home/linuxpc/Git_projects/S6_CUT` on `main` and leave other agents' worktrees alone. Reuse this branch rather than creating a checkout inside `Git_projects`.

This document is a plan, not an implemented or tested feature. Build the feature, complete the checks below, then merge the verified branch into the latest `main` as requested. Do not merge an unfinished implementation. If another agent has changed `main`, integrate and resolve relevant changes in this worktree first. Do not reset or overwrite their work.

## Required user workflow and placement

1. In Projects, choose Clip mode or Music mode and add a file or YouTube source as today.
2. In regular Clip mode, keep Funny, Serious, Educational, and Hype under Step 2, **Editorial style**. These continue to select editorial intent and influence clip selection. Directly below them, in the same Step 2 area shown in the user's first screenshot, add the regular subtitle style cards and video filter choices. Do not replace editorial intent with visual preset IDs.
3. Each regular subtitle card must show sample subtitles, as the existing Music cards do. Also show a larger selected-style sample with Play/Replay when the treatment moves. Show font, outline/background, emphasis, and placement clearly. A user must understand the selected treatment without first rendering a project.
4. In Music mode, put music-specific additions in the existing **Lyrics subtitle theme** grid shown in the user's second and third screenshots. Preserve its current nine themes and independent lyric animation controls. Put Music video filter controls beside/below that grid. Do not display regular speech subtitle choices in Music mode.
5. Keep heading content and its existing checkbox/input in their current location. Add appearance choices there; switching subtitle styles must not enable headings or generate new text automatically.
6. Create the project. Workspace must show the saved presentation settings, and playback, download, caption edits/rerenders, and ZIP export must reflect the saved choice.

Functional completeness matters more than polishing the design. Reuse existing cards, buttons, spacing, selected states, and form hints. Do not redesign the page or navigation.

## Research and reference boundaries

Planning on 2026-10-30 collected 50 public Shorts search entries representing 49 unique video IDs, fetched metadata from 14 individual Shorts pages, and inspected 12 public thumbnail images. The references establish visible treatment families. Exact fonts, filter parameters, motion timings, and whole-video behaviour were not recovered. The catalog below is an implementable interpretation, not a claim to reproduce a creator's proprietary preset.

The T3 browser could not launch because this host blocks its sandbox through AppArmor. Public YouTube page retrieval and web search worked. Do not describe this research as full playback inspection. Reference videos have not been imported through S6_CUT, and no future acceptance result is implied.

Use these references for visual direction:

- **Bold outlined speech with a coloured keyword and small graphic:** [Shehbaz Media Solutions, caption example](https://www.youtube.com/shorts/Cx__4GjULnI), 10 s. Thumbnail shows heavy white text, a yellow keyword, black edging, and a red arrow. The arrow is a graphic, not evidence of automatic emoji selection.
- **Large impact text:** [Alex Hormozi, sales example](https://www.youtube.com/shorts/QD5x8njVN80), 59 s. Thumbnail shows oversized central white/cyan text over a speaker.
- **Active-word box and high contrast:** [KYLER HOLLAND, subtitle boxes](https://www.youtube.com/shorts/C4GJeCyM45M), 45 s. Thumbnail shows a green box behind one word and bold contrasting text.
- **Large stacked caption hierarchy:** [Amro, caption tutorial](https://www.youtube.com/shorts/g5-_iPawguk), 31 s. Thumbnail shows stacked white/yellow words with strong size and weight.
- **Upper heading:** [BYRVM, visual hook](https://www.youtube.com/shorts/yfjIiuvk10g), 45 s. Thumbnail shows an upper-frame white/yellow heading above footage.
- **Separate heading and subtitle positions:** [Harry Allsop, text hooks](https://www.youtube.com/shorts/WoSM6g8DoSc), 16 s. Thumbnail shows a large heading and a smaller lower caption. It also contains a subject-over-text effect; subject masking is outside this feature.
- **Warm, contrasty footage:** [the usual., colour grading example](https://www.youtube.com/shorts/dG_EaAfy_8I), 16 s. Thumbnail shows warm urban footage and serif text; exact grading is unknown.
- **Monochrome:** [Alexandru Ghiorghiu's Films, cinematography example](https://www.youtube.com/shorts/DzOVSGzGaik), 16 s. Thumbnail visibly uses black-and-white footage.
- **Expressive lyric hierarchy:** [melongraphics, typography example](https://www.youtube.com/shorts/43UoXM2iSLY), 15 s. Thumbnail shows mixed-size stacked words over a graphic background. Implement bounded lyric typography over the user's footage, not an automatic recreation of the whole motion-design scene.
- **Coloured lyric emphasis:** [Flyyy, lyric typography example](https://www.youtube.com/shorts/onAriqsw5Es), 32 s. Thumbnail shows large type with a cyan-accented word. Perspective/3D animation is outside scope.
- **Heading strip and decorative lyric treatment:** [KAZUTO, winter typography example](https://www.youtube.com/shorts/OurHsbX09tA), 15 s. Thumbnail shows a white heading strip, decorative symbols, and separate lyric text.
- **Readable lyric plates:** [Kayred, karaoke example](https://www.youtube.com/shorts/KhzYE-1r7BA), 60 s. Thumbnail shows colour-coded lyric boxes. This supports the plate concept; it does not establish word-timed animation or justify adding singer diarization.

Keep research references as links and concise observations. Product previews must use locally authored sample content, bundled fonts, and existing licensed emoji artwork. Do not ship these creators' footage, lyrics, logos, or thumbnails in the app. Runtime YouTube scraping, an ongoing scraper service, and automatic style extraction from arbitrary URLs are outside scope.

## Confirmed existing architecture

- React 19, TypeScript, Vite, Zod, and existing CSS on the frontend; Python/FastAPI/Pydantic and FFmpeg/libass on the engine.
- `projects-view.tsx` owns creation state, the four editorial intent buttons, and Music's nine preview cards. `music-typography-controls.tsx` already has lyric animation samples and a read-only presentation summary.
- `engine/recipes.py` defines caption treatments and `LookTreatment`. `engine/media.py` already has `_shorts_grade_filter`, `_look_stages`, `write_ass`, `write_caption_sidecars`, `render_clip`, and `render_fast_clip`. The manual Shorts editor already supports picture filters; reuse internal behaviour without changing its existing settings.
- New Smart speech Shorts currently save `private["presentation"]` with `smart_speech_v2`. Historical `smart_speech_v1` and omitted presentation snapshots have their own behaviour. `write_ass` has separate overrides for these, so changing only the older recipe table will not reliably change new speech captions.
- Speech reaction artwork is controlled by a durable `reaction_policy`, currently `ironic_v1`, and bundled Fluent Emoji assets. Music suppresses speech reactions.
- Music stores `music_presentation`, with nine themes, four animation choices, and plain/white-banner hooks. `_assign_music_treatments` persists a balanced colour/grayscale assignment across clips. Explicit picture filters must account for that assignment.
- Job models and private settings are persisted as JSON through the existing database/journal machinery. Additive settings should not need a database migration.
- `engine/app.py:resolve_processing_mode` currently resolves Auto to Smart, including without an optional provider. Some prose in `ARCHITECTURE.md` is stale; follow current executable code and tests.
- Fast skips transcription/captions. Speech hook text is currently unavailable in Fast, Long form, and High-volume. Music remains short-form/Standard. Preserve those eligibility rules.
- The separate mobile app is currently a viewer for work started elsewhere. Make Projects' existing creation UI responsive, and verify mobile viewing still parses new records; do not build a new mobile creation flow.

## Files to inspect and likely touch

Read applicable `AGENTS.md` files and `DO-NOT-CHANGE/INVARIANTS.md` first.

- Creation and preview UI: `web/src/components/projects-view.tsx`, `music-typography-controls.tsx`, `common.tsx`, `styles.css`, and their existing tests.
- Contracts and submission: `web/src/types.ts`, `web/src/api.ts`, `engine/models.py`, and the existing `/api/v1/jobs/clip` handler in `engine/app.py`.
- Rendering and lifecycle: `engine/recipes.py`, `engine/media.py`, `engine/jobs.py`, `engine/music_typography.py`, `engine/emoji_assets.py`, and `engine/hook_text.py`. The current ironic-reaction rules are inside `engine/media.py`.
- Saved presentation display: `web/src/components/workspace-view.tsx` and existing Music presentation summary conventions.
- Fonts/assets: `engine/fonts/`, `web/public/fonts/`, `THIRD_PARTY_NOTICES.md`, and `third_party_provenance.json`.
- Tests: `engine/tests/test_smart_speech_presentation.py`, `test_ironic_reactions.py`, `test_music_presentation.py`, `test_music_typography_contract.py`, `test_music_motion_render.py`, `test_caption_fonts.py`, `test_recipes.py`, and `test_subtitles.py`.
- Acceptance patterns: `tests/acceptance/speech-subtitle-styles.spec.ts`, `tests/acceptance/music-lyrics-live.spec.ts`, `tests/acceptance/support/workspace.ts`, `tests/support/video-output.ts`, `scripts/qa/speech-subtitle-styles-acceptance.mjs`, `scripts/qa/verify-music-typography.mjs`, and `playwright.config.ts`.

Reasonable new files are `engine/editing_presets.py`, `web/src/editing-presets.ts`, `web/src/components/speech-style-controls.tsx`, focused test files, and `scripts/qa/editing-style-library-acceptance.mjs`. These names are proposals. Prefer equivalent existing modules if the repository has evolved. Keep render definitions separate from JSX and avoid expanding `projects-view.tsx` into another large hardcoded catalog.

## Required catalog

The following is the bounded initial catalog. IDs may be adjusted for repository conventions; labels must explain real differences. Distinct treatments must reach the renderer, not just use different CSS classes.

### Regular subtitle styles: 12 choices including the current default

1. **Editorial default** — retain today's resolved Funny/Serious/Educational/Hype presentation.
2. **Clean sentence** — restrained sans serif, sentence case, phrase grouping, no moving colour emphasis.
3. **Bold outline** — large white words with a strong dark outline; short groups, no plate.
4. **Yellow focus** — bold white phrase with exactly the spoken word highlighted yellow.
5. **Word pop** — one spoken word at a time with a small, bounded scale-in; no camera movement.
6. **Active word box** — stable phrase with a coloured plate behind the spoken word.
7. **Dark caption plate** — white phrase on a fitted dark background.
8. **Light caption plate** — dark phrase on a fitted light background.
9. **Word build** — words appear at their spoken onsets in a stable phrase layout.
10. **Cinematic serif** — readable serif phrases with subtle shadow and restrained fade.
11. **Condensed stack** — narrow bold text in a measured, bounded stack of at most three lines.
12. **Karaoke line** — stable short line with word-timed colour progression; completed words may retain the accent, future words stay neutral.

Use existing bundled font families wherever suitable. Do not assert that they are the exact fonts used by the reference creators. Presets may share fonts but must differ meaningfully in grouping, emphasis, backing, placement, or motion.

### Video filters: available in each mode's own presentation area

Provide **Existing look**, **Original colour**, **Warm**, **Cool**, **Vibrant**, **Black & white**, and **Vintage**.

- Existing look is the default and preserves the existing recipe or Music colour/grayscale assignment.
- Original colour explicitly bypasses creative colour grading while retaining the established source fitting/crop and necessary caption legibility treatment.
- Reuse `_shorts_grade_filter` for compatible warm/cool/monochrome behaviour. Compose modest vibrant/vintage settings from existing bounded FFmpeg grade/grain machinery. Keep the Vintage grain seed deterministic.
- Explicit Music filters override its automatic colour/grayscale assignment. Warm, Cool, Vibrant, Vintage, and Original colour must not accidentally start from a previously assigned grayscale image. Black & white must consistently produce grayscale footage.
- Apply footage grading before captions, heading text, creator credits, emoji artwork, and Subscribe graphics. White subtitles must remain white under a Warm filter.
- Do not change defaults, intensity semantics, tint settings, or filter IDs in the existing manual Shorts editor.

### Headings and emoji

Regular heading appearance: **Plain**, **Dark box**, **White banner**, under the existing hook-text controls. Preserve the existing unchecked default, manual/automatic content rules, eligibility, and Subscribe collision handling. A disabled/blank heading produces neither text nor background. Reuse Music's measured banner placement and fallbacks where applicable without enabling new hook-generation modes.

Speech generated emoji reactions: **Existing behaviour**, **Off**, **Sparse**. Existing behaviour preserves current defaults. Off suppresses generated reaction artwork; it must not delete literal Unicode emoji from source/caption text. Sparse uses existing deterministic reaction/emoji infrastructure with conservative placement and frequency, no new LLM call. Unsupported artwork retains the established text fallback. No eligible cue means no generated emoji. Music must not acquire speech reaction overlays.

### Music additions

Preserve all nine themes and four independent animations. Add three themes in the existing grid:

- **Karaoke focus** — readable lyric line with the current sung word accented.
- **Soft glow** — restrained white lyric text with a bounded soft glow/shadow.
- **Lyric plate** — readable text on a fitted translucent dark plate.

These must work with Original, Slow fade, Line crossfade, and Word build. Typography and animation remain independent. Reuse `music_typography.py` for blocks, fitting, and timing. Preserve current Music Plain/White banner heading choices and audio behaviour. Video filters remain independently selectable; do not add dozens of duplicate cards for every combination.

## Settings, API compatibility, and persistence

Do not redesign APIs or add endpoints/providers. The existing clip-creation endpoint has no independent regular subtitle-style setting. This feature therefore needs one narrowly scoped, backward-compatible optional presentation input and matching optional saved-job field. Do not pretend CSS or localStorage alone can implement persistent rendered choices.

Use an optional versioned `editing_presentation` multipart JSON field, exposed as `editingPresentation` in job JSON. An equivalent existing extension point is acceptable if it actually supports these choices. Suggested contents are `version: 1`, `captionPreset`, `videoFilter`, `headingStyle`, and `emojiMode`. Keep Music's existing `music_presentation` for its theme/animation/hook format; extend its theme enum only for the three new themes. Music may use the common picture-filter setting, but must reject explicitly supplied speech-only settings.

Implementation requirements:

- Keep every existing route, request field, enum meaning, response field, authentication behaviour, and provider interaction compatible. In particular, do not expand the four-value editorial `Style` enum into visual-style names.
- Mirror new types/aliases in Pydantic and Zod; validate versions, enum values, irrelevant mode combinations, and unknown keys. Invalid explicit selections must fail clearly before creating a job or downloading a source.
- Omitted presentation settings must preserve current behaviour. Preserve the historical serialization shapes where established, following `MusicPresentationConfig`'s handling of optional additive fields. New defaults must not silently rewrite old snapshots.
- Snapshot chosen presentation settings into both the saved Job and existing private job settings. Resolve against the existing presentation version and rendering path; do not globally replace `smart_speech_v1`, `smart_speech_v2`, or legacy defaults.
- Use existing JSON persistence and journals. No schema migration, production-data update, or new settings service is expected.
- Carry the snapshot through initial renders, retries, recovery, reviewed-caption rerenders, and source-only versions. Saved choices must survive page refresh and engine restart. Preserve the source-only operation's existing promise about Library overlays.
- Show the saved settings read-only in Workspace. Add presentation metadata to the existing export manifest only for jobs that selected it; preserve existing manifest fields and credits.
- Live state in the creation form is separate from completed-job state. Switching Speech/Music must not submit hidden options from the other mode. Keep the existing hook checkbox reset behaviour.

## Implementation sequence

1. Inspect current contracts, creation UI, rendering dispatch, and regression tests. Record the default behaviour before changing it.
2. Define the small typed preset catalogs and validated optional settings. Add compatibility/serialization tests before wiring controls. Keep frontend labels/previews aligned with engine preset IDs without introducing a catalog service or build-system redesign.
3. Implement the preset resolution and FFmpeg/ASS effects. Integrate with both relevant render paths and existing speech presentation overrides. Start with a small representative set, verify actual decoded frames, then complete the catalog.
4. Thread the saved settings through lifecycle paths. Add dispatch tests for retries/rerenders/recovery and Music filter overrides.
5. Add regular preview cards and selected-style playback using Music's existing interaction patterns. Wire Music additions, filters, emoji options, and eligible heading controls.
6. Add Workspace saved-setting summaries and narrowly additive export metadata.
7. Run focused tests, then the browser/media verification below. Repair in-scope failures and rerun the affected checks. Update relevant help/README wording after behaviour is verified.

You may make routine naming, layout, helper extraction, test-selector, and directly related implementation decisions. Adjust details when current code provides a better equivalent. Do not stall over minor choices or expand into unrelated refactoring.

## Preview, layout, and rendering requirements

- Use an original sample sentence such as “Small changes make a clear difference.” Use the same words across regular cards so style differences are apparent. Use original sample lyrics for Music; do not copy the reference songs.
- Reuse local bundled faces in browser previews. Several engine fonts are not currently in the web bundle: add only the necessary existing licensed font files and notices, rather than relying on whichever font happens to exist on the host.
- Preview cards must show their actual treatment family, including active-word emphasis and plates. The selected sample must reflect filter, heading, and emoji choices where relevant. A CSS demonstration may be labelled “Style sample”; do not present it as a render of the user's source.
- Use existing local help previews where appropriate, or generate locally authored examples through production rendering code. No embedded YouTube iframes or remote font/thumbnail dependency is needed.
- Respect reduced motion, use a useful still frame, and provide explicit Play/Replay. Animate only the selected sample rather than every card at once.
- Use semantic buttons, accessible labels, clear focus/selected states, and keyboard operation. Preserve the current responsive grid pattern. No fixed-width layout that overflows a narrow Projects view.
- Scale layout to the actual output canvas, fit long text, and keep outlines/plates/glow inside the safe frame. Never silently truncate transcript words. Keep captions, headings, creator credit, and Subscribe graphics from covering each other.
- Reveal word-build/pop/karaoke changes from local word timestamps. Avoid future-word emphasis, layout jitter, overlapping duplicate text, and subtitles hanging over long silence. Do not alter transcript timing, source duration, cuts, speed, or audio to manufacture an effect.
- Keep Fast caption-free. Disable caption/emoji previews and controls with a concise explanation when captions cannot be burned. Picture filters remain usable on supported Fast and Long form paths. Do not expand subtitle preset support into an unsupported path silently; gate unavailable combinations visibly and validate them server-side.
- Preserve supported Smart high-volume rendering, but keep effects bounded and use one saved choice across the batch. Hook eligibility remains unchanged.
- Missing/empty speech must still produce the established valid output or scoped warning, never fabricated text. Missing reference URLs must not affect runtime functionality.
- Preserve ASS escaping, immutable sources/blobs, atomic partial-file publication, signed media URLs, and local processing. SRT/VTT remain plain timed text and cannot represent plates, emoji artwork, colour grades, or motion.

## Testing and Playwright acceptance

### Automated checks

Add focused tests for validated selection, default compatibility, mode isolation, JSON round trips, and render dispatch. Prove selected settings reach retries and caption rerenders rather than only testing that a card receives a class name.

Exercise every new speech preset and Music theme with real FFmpeg/libass rendering of a short local fixture and known timed words. Cover each new Music theme with all four existing animations. Check the seven picture-filter choices on representative coloured footage and exercise speech/media paths that differ internally.

For meaningful visual evidence, render the same source span with identical words/timing/settings while changing only one presentation setting. Save caption-region frames, plate/heading regions, and footage-only regions as appropriate. Check before/at/after an onset for motion, empty intervals for unwanted text, and active-word geometry for boxes. Use decoded pixels and timing, not merely ASS strings or differing whole-file hashes. Compression noise is not evidence of a working style.

Use a saturated local colour fixture for filter assertions; black-and-white archival footage cannot prove a saturation or Warm/Cool filter. Check that captions and graphic colours stay unaffected by footage grading. Test explicit Music filters against the automatic grayscale assignment.

Run the repository's normal checks after focused repairs:

```bash
npm run lint
npm run typecheck
npm test
npm run test:engine
npm run build
```

Install the locked dependencies in this worktree if needed. Use the configured Python environment or isolated engine container; do not assume the command `python` exists on this host.

### Plain YouTube sources and isolated execution

Create a dedicated acceptance runner based on `scripts/qa/speech-subtitle-styles-acceptance.mjs`. Use a unique Compose project, loopback ports, and an absolute disposable `S6_DATA_PATH` under ignored `test-artifacts/`. Do not attach to, restart, or purge the user's running stack, reuse production `data/`, or copy its secrets. Preserve existing downloader URL validation and import behaviour.

Require real public YouTube imports for one speech and one sung-vocal source. Source candidates researched during planning are:

- [NASA STI Program, unedited Kennedy speech](https://www.youtube.com/watch?v=VaFTVR-hZqg). The uploader describes unedited film footage; the fetched duration is **2,093 seconds**. It is a candidate, not an already verified caption-free test interval. Its length makes it expensive: prefer a suitable shorter authorized speech source if the bounded run cannot process it. Setting a short output duration does not shorten the source download/transcription.
- [Josh Woodward, “Coffee” acoustic performance](https://www.youtube.com/watch?v=x463KE7aDAc), **168 seconds**, from the artist's channel. Its description offers the music under Creative Commons Attribution. Retain attribution and check the video footage's reuse terms as well. Inspect the selected sung interval; a title thumbnail does not establish a plain, subtitle-free video segment.

Before using a source as proof, inspect the selected interval and record that it has audible speech/singing and no existing burned subtitles, headings, or decorative emoji. Choose another appropriate public source if it fails. Record exact URL, channel, duration, selected interval, attribution, and pre-effect frames in local evidence. Do not call an edited reference Short a plain input. Do not upload or publish test outputs.

Provide source URLs as runner environment inputs. Missing/unavailable inputs must produce an explicit unmet live-test requirement, not a false pass. Do not mock YouTube import, inject `S6_TEST_TRANSCRIPT_JSON`, substitute fixture transcripts, or mock the local speech recognizer in this live journey. Deterministic render tests are separate and must be labelled accordingly.

Bound the live campaign to 60 minutes, with at most two source substitutions per mode for an external import failure. Stop with exact evidence of any remaining external blocker. Reuse downloaded source/transcription caches inside the disposable stack for further style comparisons; avoid downloading/transcribing once per card. Do not change the product's downloader architecture to accommodate the test.

### Browser workflow

Use Playwright for the following real workflow, extending the existing acceptance helpers. Use the T3 collaborative browser for interactive inspection when available; if unavailable, follow the repository's Playwright runner and record the prerequisite/error honestly.

1. Open Projects and verify all four editorial intents still work. Show the regular subtitle grid in the specified Step 2 area; click every card and verify its selected state and sample. Keep editorial intent unchanged while selecting a visual preset.
2. Change a video filter and verify the selected sample changes without changing captions. Exercise Play/Replay, keyboard controls, and reduced motion. Check at a desktop width and a narrow Projects viewport; verify the separate mobile viewer still loads new job records.
3. Switch to Music. Confirm regular-only controls disappear, all original themes remain, the three additions are in the existing grid, and theme/animation/filter choices are independent. Switch back and confirm hidden Music settings are not submitted for Speech.
4. Submit a real plain YouTube speech source with Smart/Engine only, one short output, and a non-default subtitle style. Exercise a heading through its existing enabled checkbox/input. Observe the outgoing request, processing states, and terminal result. Refresh Workspace and verify the saved settings remain.
5. Submit a real plain sung-vocal YouTube source in Music mode with a new lyric theme, a non-default animation, and an explicit filter. Verify that the chosen filter controls the result rather than an automatic grayscale assignment. Test without a replacement soundtrack first so original sung timing is unambiguous.
6. Open the actual rendered preview, download the MP4 and caption files, and use FFprobe to verify playable video/audio, expected dimensions, and duration. Confirm preview/download expose the same completed output, following existing test conventions. Compare decoded frames to the recorded input/control, and listen to representative audio for speech/lyric alignment.
7. Edit a caption and use the existing rerender action. Confirm the selected presentation survives. Exercise retry/recovery through lifecycle tests and at least one safe restart of the isolated engine, never the production stack.
8. Export a ZIP and verify its MP4, presentation metadata, and credits agree with the selected job and downloaded result.
9. Check subtitles-off and Fast controls: no burned captions or generated emoji, but the requested picture filter still works. Check heading Off/blank, unsupported combinations, long text, no-speech intervals, and an unavailable-source error without stale success UI.
10. Collect browser console errors, relevant request failures, screenshots, actual output files, sampled frames, and a machine-readable pass/fail report. Report expected validation/import errors separately from new regressions.

Use deterministic local tests for the full catalog and selected combinations; live YouTube journeys establish real import/transcription/render integration. Do not claim every style had a live YouTube run unless it did. Do not use the two live source candidates as the sole evidence for all filters or emoji triggers.

## Regression checks and protected scope

Verify the closest existing behaviours: all four default speech styles, old/missing presentation snapshots, all nine original Music themes and Original animation, caption downloads/review, Fast, Long form, High-volume, source fitting, creator attribution, Subscribe scheduling, Music audio/mixing, the manual Shorts editor, Library publication, and export.

Do not change provider configuration, keys, authentication, optional LLM behaviour, transcription models, clip-selection scoring, batch limits, source-download security, blob/reference transactions, retention/deletion, installer/Compose architecture, or unrelated UI. No new cloud/API dependency, new service, framework migration, or destructive database change. Preserve existing delivery codec/quality and do not rerender historical completed videos automatically.

## Acceptance criteria and definition of complete

- The specified regular and Music choices exist in the requested locations and reach real video rendering.
- Regular users can see meaningful subtitle previews before creating a project. Samples and exported treatments agree in font family, emphasis, backing, and motion family.
- Editorial intent remains separate from subtitle appearance. Video filters, heading appearance, and emoji controls behave as documented, and mode switching cannot leak hidden settings.
- Original defaults and historical jobs remain compatible. Settings persist through refresh, restart, retry, caption edits, source-only versions, and export.
- Every new preset has deterministic rendering evidence; new Music themes work with all four existing animations. Explicit Music filters override automatic grayscale appropriately.
- Real plain YouTube speech and sung-vocal workflows pass with local transcription and playable, visibly edited outputs. Any blocked or skipped live check is stated explicitly; the implementation is not declared fully verified while a required journey remains unmet.
- Relevant unit, engine, build, and Playwright checks pass without new runtime/console failures. Existing protected functionality passes the regression checks.
- Temporary diagnostics are removed; downloaded references, transcripts, media, private data, and large evidence stay out of Git. Keep concise reproducible verification instructions/results.
- Review the focused diff, commit the implementation, integrate the latest `main`, rerun checks affected by integration, and merge only the completed verified work. Report the final commit, actual tests performed, evidence paths, and any remaining limitation. Do not claim a push or merge unless it succeeded.
