# Video overlay diagnosis and planned solution map

Follow-up: [independent reverification and updated solution map](video-refraction-solution-map.md), including Shorts Editor exposure, fresh decoded frames, and the observed deployment compatibility blocker.

Inspected on linuxpc, 2026-10-20. Baseline: `eeb1669` (`origin/main`). Investigation branch: `diagnose/video-frame-overlay-20261020`, worktree `/home/linuxpc/git_branches/S6_CUT-video-frame-overlay`.

## Diagnosis: completed outputs feed back into automatic overlays

The nested frames are encoded in the MP4. They are not just a player display issue. A frame extracted directly from an existing output reproduces the supplied screenshot, including repeated top text, captions, source credit, dark rectangles, and the smaller grayscale scene over the color source.

The failure chain is:

1. Every successful output is published into the Library as `origin=generated-clip`. This is intentional and must remain intact.
2. `LibraryRules.explain()` considers all visible image/video assets, including generated clips and project sources. It has no overlay opt-in, origin exclusion, current-job exclusion, or current-project exclusion. A neutral asset can match simply because its normalized title occurs in the current transcript (score 20). Required assets can reserve placement without a content match.
3. `_process_clip_smart()` calls `self.rules.resolve()` on every clip's words, including Music clips. New outputs are published between successive renders, so the eligible inventory grows during the job.
4. `_source_clip_visual_metadata()` schedules any resolved real file from **0.65 seconds through min(3.4 seconds, duration − 0.2)**.
5. `_filters()` scales that file into an opaque, centered overlay box, 86% of output width by 58% of output height. Video assets loop. The imported source continues underneath.
6. When a selected output already contains an older overlay, its captions, credits, and nested frame are burned into the new overlay too. Later clips can therefore contain multiple generations of the same composition.

This explains both the few-second duration and the recursive appearance. Changing the crop, clearing browser cache, reducing caption duration, or changing LLM models would leave this path intact.

## Direct production evidence (read only)

Job `4934a355-4c91-41e0-9ed5-845ad29aeed6` is a Music / Smart / Short project with top text matching the screenshots. Its footage URL is `QbsoUNb5tEg`; its separate song URL is `GhQxrCrVSyw`. The newly supplied diagnosis video is a different source, tested separately below.

- Clip 1 has no personal-Library overlay.
- Clips 2–6 reference generated clip 1: asset `d2ec906b-34b4-4019-82dc-00a24458ac73`, title “I would never fall in love again”, hash `a160a4db00d384ce91b39b5ea426d088f9da2e2f8d30216506fbff6591d13d0b`.
- Clips 7–13 reference asset `26c71438-082f-4b23-ae99-466fc770f42f`, title “I fall into. I was lost within the darkness”, hash `b0c77cea60b96826fda4641806ec2adc1afdca3ebdf66312aed41b5609bf523e`. This asset is also a generated output of the same job and already includes an overlay.
- **12 of 13 outputs** carry personal-Library overlay provenance. Extracted output 13 at 1.5 seconds visually reproduces the screenshot.
- Replaying the saved lyric query against the current inventory selects the second generated asset at score **20**, despite its neutral policy and empty triggers/tags.
- The explanation “Neutral policy; reserved eligible placement” is misleading here: the match is a title substring, not required-policy reservation. `explain()` only includes triggers/tags in its explanation hit list.

No production jobs, Library policies, assets, originals, or saved outputs were changed or deleted.

## Modes audited

The route audit instantiated 72 valid combinations of resolved Fast/Smart, Speech/Music, Short/Long form, Standard/High-volume, all four styles, and Auto/Engine only execution. There are 32 Smart-route combinations and 40 Fast-route combinations. Requested Auto is additionally confirmed in `app.py` to resolve to Smart; Music is forced to Smart. These are routing checks, not 72 end-to-end renders.

| Mode / combination | Current route | Exposure to this automatic overlay defect |
| --- | --- | --- |
| Speech Short, Smart or Auto, Standard | Smart | Yes, if a Library file matches |
| Speech Short, Smart or Auto, High-volume | Smart | Yes |
| Music Short, any requested processing mode | Forced Smart | Yes; confirmed production example |
| Speech Short, explicit Fast, either batch size | Fast | No implicit Library lookup |
| Speech Long form, Standard, Fast/Smart/Auto | Fast | No implicit Library lookup |
| Speech Long form, High-volume, Smart/Auto | Smart exception | Yes |
| Speech Long form, High-volume, Fast | Fast | No implicit Library lookup |
| Funny / Serious / Educational / Hype | Same route rules | Style does not guard against Library media |
| Auto execution / Engine only | Same route rules | Provider use does not guard against Library media |
| Burn subtitles off | Same Smart lookup | Does not remove captions already burned into an old video asset |
| Caption revision render | `render_fast_clip`, source-based | No new implicit Library selection; its composition/provenance may diverge from the original Smart render |
| Historical Script | Creation retired | Existing encoded outputs retain their contents; inspect individually |

Music Long form and Music High-volume are rejected by the API and are not supported combinations. Source footage that already contains an overlay can reproduce that imagery in any mode; Fast cannot remove graphics baked into an imported source.

Caption rerenders can delegate to `render_clip` for presentation, but explicitly pass empty Library overlays. This is distinct from a new Smart job. It is not a supported repair workflow for the contaminated batch: verify provenance, settings preservation, and publication behavior before relying on it.

## Verification with the requested YouTube video

Downloaded [The Wolf of Wall Street (2013): TOP 3 BEST SCENES — Binge Society](https://www.youtube.com/watch?v=LwG6aia2vn0) through the existing constrained importer into isolated scratch storage. FFprobe: 1087.661 seconds, 1920×1080, AV1 video, Opus audio, 23.976 fps.

Five actual 4-second FFmpeg renders use source time 30–34 seconds:

| Render | Result |
| --- | --- |
| Speech Fast | Valid 1080×1920 H.264/AAC output, no Library overlay |
| Speech Smart renderer + resolved Library asset | Old rendered content covers the supplied footage during the overlay interval |
| Music renderer + resolved Library asset | Recursive frames reproduced over the supplied footage |
| Music source-only control (`overlays=[]`) | Supplied footage visible without old rendered content |
| Landscape Fast | Valid 1920×1080 H.264/AAC output, no Library overlay |

Compared decoded frames at 0.3, 1.5, and 3.6 seconds, before/during/after the scheduled overlay. These are direct renderer calls, not complete API jobs. The overlay-enabled cases use the existing Music job's saved lyric query and real Library inventory, then apply that resolved asset to the supplied new footage. They do **not** claim the new video's natural speech independently selects this old asset. Speech Fast and Landscape Fast use the genuine source without Library media. No new Whisper/provider calls were needed for this composition diagnosis.

Production engine hashes for jobs.py, library.py, and media.py match the inspected worktree. Existing focused tests: **77 passed, 4 skipped** (`test_library.py`, `test_fast_mode.py`, `test_long_form.py`, `test_high_volume_batches.py`). Skips reflect unavailable host FFmpeg/FFprobe; the five real renders used the engine container's binaries. Passing current tests does not establish the missing overlay exclusion: they do not enforce it.

Evidence JSON: [video-overlay-evidence.json](video-overlay-evidence.json). Raw downloaded source, five sample MP4s, frames, and the investigation driver are retained under the worktree's ignored `.qa/overlay-diagnosis/`. These are investigation artifacts, not published Library records. Browser automation could not start because the local T3 host is missing browser libraries, so no browser playback acceptance is claimed.

## Planned solution map

**Recommended default:** source footage plus the user's requested captions, emoji, hook/top text, creator credit, subscription animation, and audio. Automatic personal-Library B-roll should be disabled for normal Speech and Music projects unless the user explicitly opts in.

### Stage 1 — stop implicit media composition

Add a versioned job composition policy, for example `library_overlay_mode = off | curated`, defaulting **off for new projects**. Persist it in the public Job and private immutable settings snapshot, with matching frontend schemas and form handling. In off mode, skip Library resolution entirely and pass `overlays=[]`. Apply it to all Smart entry paths, including Music and High-volume landscape. Keep the existing renderer and all requested caption/audio/credit effects; switching every Smart job to Fast would lose required behavior.

Handle historical completed, queued, partial, and retry jobs explicitly. Do not rewrite completed files or silently change an existing checkpoint's composition. Completed outputs stay readable; repairing them creates a new source-based render/version with the off policy. Interrupted legacy work should receive a clearly recorded compatible policy, with an explicit source-only retry/new-version action where needed. This avoids silently changing user intent while preventing new jobs from inheriting the unsafe default.

Completion gate: each affected route with policy off must make zero resolver calls and produce no personal-Library video layer, regardless of library contents or provider connectivity.

### Stage 2 — separate overlay eligibility from Library membership

If optional automatic B-roll is retained, add explicit per-asset overlay eligibility, default false. Automatically published `generated-clip`, `script-output`, and `project-source` assets must not become eligible merely because they exist in the Library. Start curated automatic selection with deliberately opted-in manual assets only. Exclude the current job/project and source blob by identity as defense in depth; same-job filtering alone does not stop cross-job recursion.

Create a purpose/context-aware selection entry point that filters the eligible pool before applying existing deterministic weights, policies, dates, negatives, and tie-breaking. Keep ordinary Library browsing, export, retention, blob references, and automatic output registration intact. Do not change global list_assets to hide generated outputs. Make migrations additive. Update both API/Pydantic and frontend/zod if adding fields.

Snapshot the eligible IDs/blob identities for an opted-in job at planning time so earlier results cannot change later matches. Store the chosen asset identity and placement once; retries and caption revisions must use the same authorized composition rather than resolving against a changing live Library. Make explanation text distinguish title matches from required placement and show why ineligible assets were excluded.

Completion gate: publishing a first output never changes automatic overlay eligibility for later cuts; same-job, other-job, and previous-generation generated clips cannot be selected implicitly.

### Stage 3 — regression and real-media verification

Add meaningful regression tests before the fix, then make them pass:

- A generated video's title exactly matches the transcript; it remains excluded from automatic selection. Repeat with required policy, project-source, script-output, current source blob, current job/project, and another project's output.
- An opted-in manual B-roll asset still follows the existing required/prefer/neutral/never, date, negative-trigger, and deterministic tie rules.
- Clip 1 publishes while clips 2–3 are pending; the approved candidate pool/composition stays unchanged. Repeat after retry/restart and caption revision.
- Cover Speech Smart/Auto, Music, High-volume Short and landscape, explicit Fast, standard Long form, all styles, Engine only/Auto execution, captions off/on, Music theme/treatment/song mixing, emoji, hook/top text, credit, subscription animation, and silent-source rules.
- Build a fresh isolated end-to-end job with the supplied YouTube video and an intentionally contaminated test Library. Use a fake provider only where needed, never live production credentials. Render source-only and deliberately opted-in B-roll cases; sample actual decoded pixels before, during, and after 0.65–3.4 seconds and near EOF. Verify one source frame, requested text/effects, A/V synchronization, no frozen residual layers, valid H.264/AAC output, and truthful provenance.
- Exercise preview, standalone MP4, and ZIP export: all must contain the same authorized composition. Browser checks confirm playback after the encoded-media check.

Run affected engine/frontend tests and the repository's required checks. Do not treat mock kwargs or structural FFprobe checks alone as proof that the unwanted pixels are gone.

### Stage 4 — repair, integrate, deploy

Provide an explicit non-destructive source-only regeneration action for affected clips/projects. List potentially affected records using personal-Library provenance joined by content hash to generated/project-source assets; missing historical provenance needs separate inspection. Read the saved original source and saved words/settings; never use the contaminated output as the new source. Preserve originals and historical outputs. Publish repaired versions through the existing validated atomic render and transactional clip/asset publication flow; do not overwrite referenced blobs or delete Library records to suppress matching. Recompute provenance to describe actual rendered layers.

Fetch latest main, reconcile concurrent work, rerun affected checks, and merge the implementation branch. Deployment/rebuild is a separate step; verify the deployed revision and repeat one contaminated-Library acceptance case. Existing bad MP4s remain bad until explicitly regenerated.

## Four bounded prompts for GPT Luna

1. **Composition policy and stop:** Read this diagnosis and DO-NOT-CHANGE/AGENTS.md. Implement Stage 1 across API, persisted Job/private snapshot, frontend schema, and Smart/Music/High-volume routes. Default new jobs to no implicit Library media. Specify legacy/retry behavior. Preserve other render effects and publication. Add resolver-spy route tests. Commit and report checks.
2. **Curated eligibility and stable composition:** Implement Stage 2 with an additive eligibility field, purpose-aware filtering, manual opt-in, and job candidate/composition snapshots. Preserve all Library records and deterministic scoring. Fix misleading explanations. Test generated/title/required matches and inter-clip publication/restart. Commit and report checks.
3. **Safe repair:** Implement an explicit source-based new-version workflow for affected outputs using existing atomic/transactional publication APIs. Keep historical artifacts, settings, audio/captions, and lineage; update actual-layer provenance. Test missing originals, partial failures, retries, and caption revisions. Commit and report checks.
4. **Acceptance and integration:** Execute Stage 3 on isolated storage/ports using the supplied video and a contaminated fixture Library. Capture decoded before/during/after frames and mode results. Run required checks, update documentation, fetch and integrate concurrent changes, merge the completed implementation to main. Report deployment separately and do not claim historical outputs are repaired before regeneration.

## Delivery scope

This change delivers diagnosis, evidence, and the implementation plan only. Playback/rendering behavior is unchanged. The source-only sample demonstrates a proposed composition, not an implemented application fix.
