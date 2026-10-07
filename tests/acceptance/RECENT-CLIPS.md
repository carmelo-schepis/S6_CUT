# Recent clips acceptance prerequisites and contract

This is a real-browser contract suite, not a mocked UI test. It is deliberately
not runnable against the app's normal defaults. The runner must explicitly set:

```sh
npm run test:e2e:recent-clips
```

The runner creates a unique `/tmp/s6-recent-clips-<run-id>` data directory,
seeds it in a one-shot engine container, starts a uniquely named disposable
Compose project on loopback ports in `20000–65535`, runs the real-browser spec,
restarts that project’s engine to check deletion persistence, and removes only
its own stack and temporary data. Screenshots and reports are retained under
`test-artifacts/s6-recent-clips-<run-id>/`.

The directory must belong to a separately started disposable engine+web stack;
never point it at the current app, port 8080, a shared/default data directory, or
a Docker volume containing real data. Use a new unique path and loopback port
(20000–65535) for each run. The spec fails closed (rather than skipping) if the
fixture marker is missing, URL is not loopback, or the data path is not named
`/tmp/s6-recent-clips-<unique-run-id>`. The existing global Playwright config keeps its legacy 8080 fallback for other
suites; this runner always supplies the isolated URL and redirects its reports
into a per-run artifact directory without cleaning existing test artifacts.

## Fixed backend contract

The real engine must serve
`GET /api/v1/library/recent-clips?search=&page=1&page_size=12` as:

```json
{"items": [], "page": 1, "pageSize": 12, "hasMore": false, "total": 0}
```

`items` are complete camelCase `Asset` records and recent clips include only
asset-backed `generated-clip` / `script-output` outputs, with source project,
job and clip IDs and server-signed preview URL. IDs (not project names or titles)
are the identity throughout selection and deletion.

## UI selectors assumed by this spec

The current UI exposes `.recent-clips-section`, `.recent-clip-card`, accessible
`Preview <title>` and `View in Library` buttons, and a `Search recent clips`
searchbox. Every Recent clip and Library card exposes `data-asset-id`; the test compares
that stable identity directly with API results. Library cards also use
`.asset-card.active` and `Select <title>` checkboxes; deletion is through
Library's `Search media`, `Delete`, and confirmation dialog. Preview is the real
`VideoPreviewDialog` video.

## Disposable fixture requirements

Before starting the app, create a unique new data directory and run the included
seeder with `S6_DATA_PATH` and `S6_ACCEPTANCE_URL` set. It refuses non-empty data
roots and non-`/tmp` paths and uses engine `Database`/`LibraryRules` plus ffmpeg
to publish actual content-addressed media. It creates 15 stopped historical
projects/jobs without output assets (one with a resumable partial import); three completed projects with five playable
generated output assets each; one script-output; one linked project-source; a
manual import; duplicate output titles across projects; a removable folder; and a
protected asset. Do not clone/alter an existing live DB or media.

The test intentionally fails (not skips) when the contract or fixture is
absent. It also verifies on the initial Projects view that the Recent projects
heading/count, search, refresh, cards, deletion, progress, pagination, and its
empty/loading states are absent, while checking the page has no horizontal
overflow at desktop and mobile widths. Recent clips membership/search/count,
real preview playback, and View in Library selection remain covered against the
seeded output assets.

For the restart check, restart only the disposable Compose project after the
browser test and verify the empty Recent clips API still returns zero; never
restart or mutate a shared service. Only after that empty-result persistence
assertion passes, the runner invokes `recent-clips-projects.spec.ts`. This
post-restart real-app test checks that Recent projects remains absent after a
reload, the project-creation form and Settings remain available, Jobs & recovery
and Workspace navigation work. Submitting a disposable Clip project using
the isolated fixture video opens that exact project's Workspace. Jobs & recovery
access checks the seeded `Retry import` control remains available for stopped
partial work; no retry/control mutation is issued against historical fixture jobs.

## Coverage status

The spec covers first-page membership/order and exact asset-ID selection (including
duplicate titles and page two), server search/counts, decoded preview progression,
delayed stale responses, single and bulk UI deletion, source cascade, protected
failure retention, folder removal, empty results while stopped job history and a
source asset remain, purge confirmation and cross-tab propagation, reload/fresh
context, desktop/mobile screenshots, and browser console/request errors. A
post-test engine restart check is run externally against the disposable Compose
project to verify deletion persistence. Keep destructive operations limited to
seeded IDs.
