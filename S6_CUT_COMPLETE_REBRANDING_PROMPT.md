# S6_cut — complete repository rebranding and namespace migration prompt

You are a senior full-stack engineer responsible for a careful, repository-wide product and codebase rebrand.

Work in:

```text
C:\Users\charl\Desktop\S6_cut\S6_cut
```

The only first-party product brand permitted after this migration is:

```text
S6_cut
```

The canonical GitHub repository is:

```text
https://github.com/carmelo-schepis/S6_CUT.git
```

Official source logo files are located at:

```text
C:\Users\charl\Desktop\S6_cut\LOGO\Default logo.png
C:\Users\charl\Desktop\S6_cut\LOGO\App icon.png
C:\Users\charl\Desktop\S6_cut\LOGO\Logo for legal.png
```

Your task is to remove the old `ClippyMe` identity and any other obsolete first-party branding, replace it consistently with `S6_cut`, implement the official logos throughout the application and documentation, and delete superseded brand assets after verifying that nothing still references them.

Do not merely perform a case-sensitive search-and-replace. This is a coordinated package, configuration, storage, UI, Docker, documentation, and compatibility migration. The finished project must build, test, install, and run normally.

## Safety rules

1. Read `AGENTS.md` and all of `CLAUDE.md` before changing anything.
2. Inspect the working tree before editing. Preserve unrelated user changes.
3. Create an inventory of every old brand reference and old brand asset before modifying files.
4. Do not delete the repository, source code, user data, generated videos, configuration, test fixtures, or functional third-party integrations.
5. “Delete it” means delete obsolete branding text, identifiers, directories, and image assets after their replacements work. It does not authorize deleting unrelated project content.
6. Remove every license badge, license link, copyright line, notice heading, package field, or attribution sentence that presents `ClippyMe` as the current project, owner, author, licensor, or product. The existing root `LICENSE` currently contains `Copyright (c) 2026 ClippyMe`; that line must not survive. Replace project-level licensing with an accurate `S6_cut` license/copyright identity chosen or confirmed by the repository owner. Do not invent ownership of third-party code. Legally required third-party copyright and license text may remain only in a dedicated third-party notices file, stripped of any wording that brands the current application as ClippyMe.
7. Do not rewrite git history or force-push.
8. Do not change the configured Git remote unless explicitly authorized to perform repository operations. Update documentation and repository metadata to the canonical URL; report the exact safe command for changing `origin` if it is currently different.
9. Use atomic or staged moves for large namespace changes. Never leave two competing source packages active.
10. Run tests after each migration stage so failures are localized.

## Required brand spelling

Use these conventions consistently:

- User-facing product name: `S6_cut`
- Python import package: `s6_cut`
- Python distribution/project name: `s6-cut` where packaging standards prefer hyphens
- Docker/Compose project and service image prefix: `s6-cut`
- Environment variable prefix: `S6CUT_`
- JavaScript storage and cache prefix: `s6_cut_`
- CSS class names should normally remain semantic; rename only classes containing an old brand
- Logger name: `s6_cut`
- User agent prefix: `S6_cut`
- Internal exception base class: `S6CutError`
- Hidden runtime/checkpoint names: `.s6_cut_runtime.json` and `.s6_cut_checkpoint`

Do not introduce variants such as `S6 Cut`, `S6Cut`, `s6cut`, or `S6_CUT` in user-facing copy unless a platform or file-format convention requires it. The GitHub repository slug is the supplied `S6_CUT`; the displayed app name remains `S6_cut`.

## Phase 1 — inventory and migration map

Before editing, search case-insensitively for all old product identities and likely remnants, including:

```text
clippyme
clippy me
ClippyMe
CLIPPYME
openshorts
open shorts
fable5
old repository owner URLs
old Docker image names
old package metadata
old logo filenames and hashes
```

Search source files, filenames, directory names, hidden files, CI workflows, Docker configuration, documentation, tests, browser storage keys, cache names, HTTP user agents, loggers, generated metadata names, screenshots, manifests, icons, and binary/image assets.

Produce a migration table with these columns:

| Old item | Category | Replacement | Compatibility/data concern | Verification |
|---|---|---|---|---|

Classify occurrences as:

- Current first-party branding: must be replaced.
- Internal namespace: must be migrated carefully.
- User-persisted key/path: requires data migration.
- Third-party legal obligation: preserve only the component-specific text that is legally required. Delete or neutrally rewrite optional brand-history material so it cannot suggest the current product is ClippyMe.
- Test fixture/comment: update if it describes the current product; retain only when testing legacy migration intentionally.
- Obsolete asset/file: replace, verify unused, then delete.

Do not start bulk replacement until this map exists.

## Phase 2 — Python package and internal namespace

Rename the Python source package from:

```text
src/clippyme
```

to:

```text
src/s6_cut
```

Update every import, module invocation, entry point, test import, monkeypatch target, Docker command, subprocess command, coverage path, ruff command, documentation example, and dynamic string reference.

Examples include:

```text
clippyme.api.app                  -> s6_cut.api.app
clippyme.pipeline.orchestrator    -> s6_cut.pipeline.orchestrator
python -m clippyme...             -> python -m s6_cut...
src/clippyme                      -> src/s6_cut
ClippyMeError                     -> S6CutError
logging.getLogger("clippyme")     -> logging.getLogger("s6_cut")
```

Update `pyproject.toml` so the distribution is named appropriately and package discovery finds `s6_cut` only.

Do not leave a duplicate `clippyme` compatibility package in the final tree, because the explicit requirement is to remove that namespace. If a temporary compatibility shim is needed during development, remove it before completion.

Update docstrings and comments that describe the current system. Do not change technical behavior merely to complete the rename.

## Phase 3 — configuration and persistent data migration

Rename all first-party environment variables from `CLIPPYME_*` to `S6CUT_*`, including configuration reads, `.env.example`, Compose files, Dockerfiles, documentation, tests, and deployment examples.

Examples:

```text
CLIPPYME_BIND                   -> S6CUT_BIND
CLIPPYME_API_TOKEN              -> S6CUT_API_TOKEN
CLIPPYME_JOB_MAX_ATTEMPTS       -> S6CUT_JOB_MAX_ATTEMPTS
CLIPPYME_X264_CRF               -> S6CUT_X264_CRF
CLIPPYME_X264_PRESET            -> S6CUT_X264_PRESET
CLIPPYME_CREATOR_NAME           -> S6CUT_CREATOR_NAME
```

Perform a complete inventory rather than relying only on these examples.

Rename persisted internal files and directories:

```text
.clippyme_runtime.json    -> .s6_cut_runtime.json
.clippyme_checkpoint     -> .s6_cut_checkpoint
```

Rename browser storage/cache keys from `clippyme_*` to `s6_cut_*`.

Existing users must not lose settings, job state, presets, clip edit state, or resumable jobs. Implement a one-time migration that:

1. Detects existing legacy keys/files.
2. Copies or atomically renames them to the new name.
3. Never overwrites a newer destination.
4. Is idempotent and safe to run repeatedly.
5. Records only a neutral migration version marker.
6. Removes the old key/file after successful verification.

Because the final repository must contain no old first-party identifier, isolate any unavoidable legacy detection constants in a generated migration mapping or encoded migration fixture, execute the migration during the release transition, and remove the transitional implementation in the final clean-release state once migration is no longer required. If immediate zero-occurrence source is prioritized over in-app migration, supply a separate one-shot migration tool and document that it must be run before upgrading. Clearly report this tradeoff rather than silently discarding user data.

Never rename generic third-party environment variables such as `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, or `ELEVENLABS_API_KEY`.

## Phase 4 — frontend branding

Replace all visible old product naming with `S6_cut`, including:

- Browser title and metadata
- Header/navigation brand
- Accessible labels and image alt text
- Hero copy
- Create, Processing, Results, History, Library, Settings, Live Monitor, and modal copy
- Toasts and error messages
- PWA manifest name and short name
- Service worker/cache name
- Install prompts
- Download names and ZIP manifests
- API docs title and server messages
- Footer, About, Legal, diagnostics, and version panels
- HTML metadata and Open Graph/social metadata if present

Update comments that call the live UI a “ClippyMe redesign.” Remove stale design-handoff branding from production code.

Do not blindly replace third-party integration names. For example, “Gemini model” remains correct if it refers to the Gemini integration, but “ClippyMe will pick the clips” becomes “S6_cut will pick the clips.”

## Phase 5 — official logo implementation

Use the supplied source files as authoritative. Inspect their actual dimensions, alpha channel, color profile, padding, and legibility before processing them.

### `Default logo.png`

Use for prominent product branding such as:

- Main dashboard/navigation logo
- README header
- About screen
- Loading/splash screen where a full logo is appropriate
- Social preview image where its proportions are suitable

### `App icon.png`

Use as the source for:

- Browser favicon
- Apple touch icon
- PWA icons at required sizes, including at least 192×192 and 512×512
- Maskable PWA icon with sufficient safe-zone padding
- Windows/desktop shortcut icon where supported
- Small square navigation/app mark

Generate derivatives from the source without stretching, recoloring, redrawing, or changing its proportions. Preserve transparency where appropriate. Use high-quality resizing and verify every generated icon visually.

### `Logo for legal.png`

Use for:

- Legal/About attribution presentation
- License/about documentation where the supplied legal variant is intended
- Any required formal brand display

Do not use the legal logo as the normal small app icon unless visual inspection proves that is its intended role.

Copy optimized derivatives into appropriate repository-owned asset locations such as `dashboard/public/` and production component asset folders. Use clear brand-neutral filenames such as:

```text
s6-cut-logo.png
s6-cut-icon-192.png
s6-cut-icon-512.png
s6-cut-icon-maskable-512.png
s6-cut-apple-touch-icon.png
s6-cut-legal-logo.png
```

Update all imports and URLs. Then identify and delete superseded old logo assets such as old SVG marks, old redesign logo images, stale favicons, and duplicate brand images—but only after a reference search proves they are unused.

Do not delete the authoritative source files in `C:\Users\charl\Desktop\S6_cut\LOGO`; they are outside the application repository and must remain the master originals.

Visually verify at minimum:

- Header at desktop width
- Header at narrow/mobile width
- Favicon/browser tab
- PWA install icon
- Maskable icon crop
- README rendering
- Dark and light backgrounds if both themes exist
- Legal/About presentation

## Phase 6 — repository, Docker, CI, and deployment branding

Update:

- Git clone URL
- Issue/report links
- README badges
- Repository/homepage/bug-tracker metadata
- Docker image names and labels
- Compose project/container/image names
- Health-check messages
- User-Agent strings
- API application title and description
- CI workflow artifact names
- Coverage package paths
- Commands in `CLAUDE.md`, `TESTING.md`, schedules, architecture docs, and deployment guides
- TrueNAS and Portainer examples
- `.env.example`
- Startup scripts and Windows command files

Use the canonical URL everywhere:

```text
https://github.com/carmelo-schepis/S6_CUT.git
```

Use appropriate canonical sub-links:

```text
https://github.com/carmelo-schepis/S6_CUT/issues
https://github.com/carmelo-schepis/S6_CUT/blob/main/LICENSE
```

Inspect the existing git remote without modifying it. If `origin` is not canonical, report:

```bash
git remote set-url origin https://github.com/carmelo-schepis/S6_CUT.git
```

Only execute that command when separately authorized.

## Phase 7 — licensing, documentation, and attribution cleanup

Rewrite the README introduction so `S6_cut` is clearly the current product. Replace old badges, screenshots, alt text, commands, package names, and links.

Update `CLAUDE.md` so it remains the authoritative current-state architecture guide after the namespace migration.

Remove all legacy project-level licensing traces, including:

- The `Copyright (c) 2026 ClippyMe` line in the current root `LICENSE`
- README license badges that resolve through `fralapo/clippyme`
- Old license links, badge URLs, repository-owner links, package metadata, author fields, and copyright headers
- Any statement suggesting ClippyMe owns, publishes, licenses, or maintains the current repository
- Any old brand name embedded in About, Legal, API metadata, Docker labels, generated manifests, or application credits

Replace them with the correct `S6_cut` identity and canonical repository URL. If the project is to remain MIT-licensed, create a clean MIT `LICENSE` whose project-level copyright holder is the owner-confirmed S6_cut holder—not `ClippyMe`—while keeping any legally required notices for incorporated third-party code separately. If the repository owner has not supplied the exact copyright-holder wording or wants a different license, stop before fabricating it and request that one legal identity decision.

The finished repository must contain no license or notice that can be mistaken as evidence that the current app is ClippyMe.

Preserve unavoidable third-party license obligations in a dedicated `THIRD_PARTY_NOTICES.md` or equivalent. Such notices must identify only the relevant third-party component and its actual copyright/license. They must not use ClippyMe as the current application name, author, intermediary, or section title. Do not present an upstream project as the current product.

Rename historical documentation files whose filenames contain obsolete internal project brands. Rewrite current-state portions; preserve useful engineering history in neutral language.

Do not falsify copyright ownership. Remove obsolete first-party ClippyMe ownership claims, but do not remove a third-party author/licensor when the incorporated license legally requires that notice. Keep those obligations isolated from S6_cut product branding.

## Phase 8 — delete obsolete branding safely

After all replacements compile and tests pass:

1. Search for references to every obsolete brand asset.
2. Delete only assets with zero remaining references.
3. Delete the old `src/clippyme` directory only after the complete `src/s6_cut` package works.
4. Remove stale duplicate Docker/CI configurations that exist solely for old branding.
5. Remove old generated icons and logo files from the application repository.
6. Remove obsolete comments, example commands, browser storage constants, and package metadata.
7. Confirm no import or runtime path still depends on a deleted name.

Report every deleted file and why it was safe to delete.

## Verification requirements

Run comprehensive searches using case-insensitive patterns and filename searches. The current product code and normal documentation must have zero matches for obsolete first-party branding.

At minimum run an equivalent of:

```bash
rg -n -i "clippyme|clippy me|CLIPPYME|fable5" .
find/rg filename checks for old branded paths and assets
```

Review any remaining `OpenShorts` references manually. They are permitted only where a redistributed third-party license legally requires them. Remove optional historical/promotional references that are not legally required and could make the current product look like another brand.

Also verify:

- `src/s6_cut` is the only first-party Python package.
- No Python imports reference the removed namespace.
- No subprocess invokes the removed module path.
- No environment documentation uses the old prefix.
- No browser storage/cache keys use the old prefix.
- No runtime/checkpoint files are created under the old name.
- No old repository owner URL remains.
- No old logo is bundled or referenced.
- README badges and links resolve to the canonical repository, with no badge or license URL referencing the old owner or repository.
- The root license contains no `ClippyMe`, old repository owner, or old repository URL.
- Dedicated third-party notices contain no sentence that presents ClippyMe as the current project or copyright holder.
- PWA manifest and icons use `S6_cut`.
- API metadata uses `S6_cut`.
- Docker image/service/container naming uses `s6-cut`.

Run all commands specified by `CLAUDE.md`, including:

- Backend host tests
- Ruff bug-class checks
- Frontend tests
- Frontend lint
- Frontend production build
- Docker CPU build and health check
- A small end-to-end processing smoke test where supported

Add or update tests for:

- Python import path and CLI module path
- New environment prefix
- Runtime/checkpoint filename migration
- Browser storage migration
- PWA manifest branding
- API title/root response branding
- README/repository-link guard
- A repository scan that rejects reintroduction of obsolete first-party brand strings or assets

The guard test must not broadly allow-list history or notice files. It may exempt only exact, component-specific third-party legal text that cannot lawfully be altered, and it must still reject every occurrence that describes the current project as ClippyMe.

## Definition of done

The rebrand is complete only when:

- The application displays `S6_cut` everywhere as its sole first-party product identity.
- The Python package is `s6_cut`, not the old namespace.
- First-party environment variables use `S6CUT_*`.
- Browser storage, caches, loggers, user agents, Docker resources, runtime files, and internal metadata use the new identity.
- The official supplied logos are correctly used in the dashboard, favicon, PWA, README, and legal/About presentation.
- Superseded branding assets have been deleted only after reference verification.
- The canonical repository URL is used in documentation, badges, metadata, and issue links.
- Required third-party licenses remain accurate, isolated, and contain no wording that identifies the current application as ClippyMe.
- Backend tests, frontend tests, lint, build, Docker health checks, and smoke tests pass.
- A final case-insensitive scan finds no obsolete first-party branding anywhere, including the root license, badges, notices, copyright headers, and historical documentation. If a third-party legal notice literally contains the same text and cannot legally be altered, report the exact source and legal requirement rather than silently allow-listing it.
- No user settings, resumable jobs, presets, clip states, or stored media are lost by the migration.

At completion, provide:

1. The initial branding inventory.
2. Every renamed directory, package, variable prefix, storage key, and runtime file.
3. Every generated logo derivative with dimensions and usage.
4. Every deleted obsolete asset/file.
5. Tests and commands run with results.
6. Remaining third-party names and the exact legal or technical reason each must remain; none may imply that the current product is ClippyMe.
7. The current git remote and, if needed, the exact unexecuted command to point it at the canonical repository.
