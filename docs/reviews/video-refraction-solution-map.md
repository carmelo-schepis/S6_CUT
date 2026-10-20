# Video refraction: verified cause and solution map

Reverified on **linuxpc, 2026-10-20**, against main `5332c55`, in isolated branch `diagnose/video-refraction-map-20261020`, worktree `/home/linuxpc/git_branches/S6_CUT-video-refraction-map`. This is a diagnosis and implementation handoff; no application rendering behavior or production records were changed.

## Finding

**Completed videos are automatically reused as Library overlays on later videos.** The smaller video already includes captions, top text, credits, and sometimes an earlier overlay, so the result contains several nested generations. The overlay is scheduled at **0.65–3.4 seconds** (shorter for clips under 3.6 seconds), which explains why the problem clears after a few seconds.

The existing production job matching the screenshots (`4934a355-4c91-41e0-9ed5-845ad29aeed6`, Music/Smart) has **12 of 13 clips** with personal-Library overlay provenance. The selected generated asset belongs to that same job. Its hash and origin match the prior investigation. This confirms the earlier [detailed diagnosis](video-overlay-diagnosis.md).

### Evidence using the supplied video

Used the retained genuine download of [The Wolf of Wall Street (2013): TOP 3 BEST SCENES](https://www.youtube.com/watch?v=LwG6aia2vn0), ID `LwG6aia2vn0`, SHA-256 `ae1ebeef6361eb280ce8ffbb4cf951631ce50027fb9ff7f73d8f1af6c472fc3c`. Fresh renders use source seconds 30–34.

| Current renderer with matched generated overlay | Same renderer with `overlays=[]` |
| --- | --- |
| ![Old generated content nested over the requested footage at 1.5 seconds](evidence/video-refraction/implicit-overlay-1.5.jpg) | ![Requested footage without the generated-video layer at 1.5 seconds](evidence/video-refraction/source-only-1.5.jpg) |

Both renders keep the same Music theme, top text, timing, and source. At 0.3, 1.5, and 3.6 seconds the average absolute decoded gray-pixel differences are **0.0813, 10.0858, and 0.0945** respectively (0–255 scale; frames downscaled identically to 180×320). The difference is concentrated inside the scheduled overlay interval. Visual inspection shows the same nested captions and rectangles as the supplied screenshots. A fresh square Fast render also validates at 1080×1080, H.264/AAC.

These are **direct FFmpeg renderer experiments**, not full API jobs. The saved affected Music lyric query selects the real generated asset; the supplied new video supplies the underlying footage. This does not establish that this video's natural dialogue would select that asset independently. Earlier evidence includes Speech Smart, Speech Fast, Music, and landscape renders. No new Whisper or provider calls were needed.

## Code path and why it recurs

1. [`_publish_output`](../../engine/jobs.py#L1151) registers successful outputs as `generated-clip`. Keep this intentional Library publication behavior.
2. [`LibraryRules.explain`](../../engine/library.py#L114) iterates all visual assets, without an overlay eligibility or origin gate. A title substring alone contributes 20 points; `required` can reserve placement even without a content hit.
3. [`_process_clip_smart`](../../engine/jobs.py#L2050) resolves again for each clip immediately before rendering ([line 2260](../../engine/jobs.py#L2260)), after earlier clips have published. Planning-time labels do not freeze the eventual rendered selection.
4. [`_source_clip_visual_metadata`](../../engine/jobs.py#L380) schedules the resolved file at 0.65–3.4 seconds.
5. [`_overlay_inputs`](../../engine/media.py#L2185) loops video assets; [`_filters`](../../engine/media.py#L2380) scales/pads them into an opaque centered box, 86% of output width by 58% of height.
6. A selected clip containing its own overlay carries all of those older pixels into the next output. The live candidate pool allows the same job to feed itself, and other jobs' outputs can also seed recursion.

The title-match explanation currently says “reserved eligible placement” when no trigger/tag hits are listed, even for a neutral title match. Fix that diagnostic text independently of the deterministic scoring weights. Changing the language model does not change this local selection/composition path.

## Mode exposure map

Independently reran **72 resolved route combinations**: 32 Smart and 40 Fast, spanning Speech/Music, Short/Long, Standard/High-volume, all four styles, and Auto/Engine only execution. These are route checks, not 72 media renders. Inspected the remaining creation, rerender, and download paths separately.

| Mode or action | Route on inspected main | Exposure to adding this unintended Library layer |
| --- | --- | --- |
| Speech Short: Smart or requested Auto; either batch size | Smart | Yes, if a visual asset matches |
| Speech Short: explicit Fast; either batch size | Fast | No implicit visual lookup |
| Music Short: Fast/Smart/Auto requested | Forced Smart | Yes; production example confirmed |
| Speech Long: Standard, any processing mode | Fast | No implicit visual lookup |
| Speech Long: High-volume Smart/Auto | Smart exception | Yes |
| Speech Long: High-volume Fast | Fast | No implicit visual lookup |
| **Shorts Editor: burned or embedded captions enabled** | Smart via `_queue_shorts_job` | **Yes; include in fix and regression coverage** |
| Shorts Editor: burned and embedded captions both disabled | Fast | No implicit visual lookup |
| Shorts Editor source: Library selection, upload, or YouTube | Same caption-dependent routing | Source choice does not guard Smart composition |
| Funny / Serious / Educational / Hype | No eligibility gate | All share their route's exposure |
| 9:16 / 16:9 / 1:1 / 4:5 where supported | Shared compositor | Aspect changes geometry, not eligibility |
| Auto execution / Engine only; provider disconnected | Same local lookup | Cloud access does not prevent the defect |
| Subtitles off on an otherwise Smart Clip job | Smart | Old video's burned captions remain visible |
| Music color / grayscale, theme, top text, separate song/mixing | Same Smart lookup | Cosmetic/audio options do not prevent it |
| Retry / resume / restart on Smart job | Live resolver again | Candidate choice can change as inventory changes |
| Switch to Fast | New source-based Fast job | No new automatic Library layer; loses Smart-only features |
| Caption revision | Source-based `render_fast_clip`, empty overlays | No new implicit lookup; do not treat as a complete repair workflow |
| Download Video (`video-downloads`) | Download + MP4 remux/transcode | No Library compositing; existing source pixels remain |
| Preview / standalone MP4 / ZIP | Consume already rendered outputs | Existing bad pixels remain in each delivery path |
| Script / AI Video creation | Retired | Historical outputs can still carry baked-in layers |

Music Long and Music High-volume are rejected combinations. Fast and source-only rendering cannot remove an overlay already baked into the imported **source**. Repairs must use the clean saved original, not an affected generated clip selected from the Library.

The Shorts Editor exposure is an addition to the original mode map: [`_queue_shorts_job`](../../engine/app.py#L689) selects Smart when `burn_subtitles` **or** `embed_subtitles` is enabled. Its public upload/URL form and authorized Library-source route both reach that helper.

## Separate current deployment blocker

At approximately **03:41 UTC on 2026-10-20**, local read-only HTTP checks returned:

- `GET /api/v1/health`: **200**.
- `GET /api/v1/library/assets?limit=1`: **500**.

The running engine's strict `Asset` model rejects the saved `videoOverlayEligible` field. Container logs confirm `ValidationError: Asset / videoOverlayEligible / Extra inputs are not permitted`; 176 asset payloads contained the field at investigation time. Running `jobs.py`, `library.py`, `media.py`, and `models.py` hashes match the inspected main baseline. The unmerged implementation branch adds that field to its model.

This is a **persisted-data/deployed-code compatibility mismatch**, distinct from the original encoded-video problem. The investigation did not establish who wrote the field. Restore a coordinated compatible engine/frontend/database deployment and verify real Library/job endpoints. Do not delete assets, strip fields from production, or relax all model validation as a workaround. Health alone is not a sufficient deployment acceptance check.

For the fresh baseline experiment only, the driver removed this one unknown field from an **in-memory copy** of read-only asset payloads so the original deployed matching behavior could be evaluated. It did not write to SQLite or repair the live endpoint. This projection is recorded in the evidence.

## Planned implementation, in order

| Phase | Work | Completion gate |
| --- | --- | --- |
| 0. Coordinate current state | Reconcile existing implementation branch and deployment compatibility. Back up persistent data before any deployment/migration. Use isolated test data. | Compatible deployed schemas; Library and job reads work, not only health. |
| 1. Stop implicit overlays | Default new jobs to no personal-Library video composition. Persist the choice in public Job, private snapshot, API, and frontend. Skip **all** resolver calls in off mode, including planning labels. Cover Smart Speech, Music, High-volume landscape, and Shorts Editor. Specify legacy queued/recovered/retry behavior. Preserve captions, emoji, hook/top text, credits, subscriptions, and audio. | A contaminated Library cannot add a video/image layer to any default new source-based job. No silent switch of all jobs to Fast. |
| 2. Make optional B-roll explicit and stable | Require both job opt-in and deliberately approved manual assets. Exclude generated clips, Script outputs, project sources, and current job/project/source identity. Freeze authorized choices before publishing the first output; persist IDs, immutable blob identity, timing, and provenance through retry/restart/caption revisions. Keep scoring weights and normal Library visibility unchanged. | Publishing clip 1 cannot change the composition of clips 2 onward. Other projects' generated outputs cannot be selected implicitly either. |
| 3. Repair old outputs safely | Add an explicit source-only new-job/version action using original source, exact saved trim, edited captions/timing, treatment, text, audio settings, and lineage. Preserve old outputs. Publish new validated files through existing transactional clip/asset APIs. Recompute actual-layer provenance. | Original bytes and old references remain intact. New outputs contain the authorized composition and remain downloadable/exportable. |
| 4. Verify and integrate | Exercise every exposed route against a contaminated isolated Library, plus deliberate manual B-roll opt-in. Test inter-clip publication, cross-job recursion, legacy/retry/restart, unavailable blobs, caption revisions, and regeneration failure/retry. Decode frames before/during/after the interval; check A/V sync, text/effects, dimensions, MP4, preview, and ZIP. Run repository gates, integrate latest main, then deploy compatible services. | Real decoded pixels contain no unrequested old content; actual Library/job endpoints and playback work after deploy. Existing bad outputs are only claimed repaired after regeneration. |

### Handoff to GPT Luna

An implementation already exists on **`fix/explicit-library-video-overlays-20261020`**, observed at `e765444`, in `/home/linuxpc/git_branches/S6_CUT-explicit-library-video-overlays`. It adds default-off job policy, explicit manual-asset eligibility, choice snapshots, and a source-only regeneration path. **It was not merged or deployed as part of this diagnosis, and this inspection is not an acceptance certification.** Continue that work rather than implementing a competing copy. Its worktree had an untracked `node_modules` entry; leave other agents' files alone.

Use one bounded prompt per phase from the [original handoff](video-overlay-diagnosis.md#four-bounded-prompts-for-gpt-luna), with these additions:

1. Include both Shorts Editor endpoints and the embedded-captions-only case in default-off route tests. Verify legacy recovered/retry behavior explicitly.
2. Certify actual persisted choice replay, ineligible asset exclusion, and truthful title-match explanations; inspect missing-blob behavior and snapshot identity retention.
3. Verify repair preserves edited caption cues/timing, per-clip Music treatments/gains, top/hook text, source trim, and requested effects through the **executed** render/publication, not only copying a queued Job object.
4. Resolve the live strict-model field mismatch with coordinated deployment; verify health **and** Library/job reads. Do not use production storage for implementation tests. Complete contaminated-Library API/media acceptance before merging the implementation.

## Verification and retained artifacts

Focused tests run from this isolated branch: **113 passed, 10 skipped** across `test_library.py`, `test_fast_mode.py`, `test_long_form.py`, `test_high_volume_batches.py`, `test_shorts_source.py`, and `test_video_downloads.py`. Skips are existing media-tool gates on the host; fresh FFmpeg experiments ran inside the existing engine container with outputs only in `/tmp`. Passing baseline tests does not establish the missing exclusion rule.

Fresh machine-readable evidence: [video-refraction-reverification.json](video-refraction-reverification.json). Fresh sample frames are linked above. The read-only driver, three MP4s, all before/during/after frames, evidence, and focused test log are retained under this branch worktree's ignored `.qa/refraction-reverification/`. The initial source download remains in the prior investigation's scratch directory. No production job was queued or published by this investigation.

Browser playback acceptance was not performed: T3 preview startup reported missing host libraries (`libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libasound.so.2`). Decoded-media checks establish the rendering defect independently of browser playback.
