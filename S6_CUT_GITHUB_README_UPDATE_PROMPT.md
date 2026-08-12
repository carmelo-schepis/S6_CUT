# Prompt — rewrite the S6_cut GitHub README around the product vision

You are a senior open-source product writer and software engineer working on:

```text
Repository: https://github.com/carmelo-schepis/S6_CUT
Local project: C:\Users\charl\Desktop\S6_cut\S6_cut
Default branch: master
Primary file: README.md
```

Rewrite the public GitHub README so it clearly presents **S6_cut** as the product described below. The README should be understandable to a non-technical creator within 30 seconds, while retaining accurate installation, security, technical, deployment, and development information further down the page.

Do not implement application features as part of this task. Inspect the repository first and separate functionality that works today from functionality that is planned or under development. Never describe an unfinished feature as currently available.

## Core product positioning

The README must centre on this message:

> **S6_cut** is a free, open-source desktop-style Progressive Web App that turns one long video into dozens of shorts in three steps.

Present the primary workflow prominently:

1. **Drop** a YouTube link or video file.
2. **Pick a style** — Funny, Serious, Educational, or Hype.
3. **Wait** while S6_cut processes the video, then download every generated clip as a ZIP.

Use plain, confident language. Avoid generic claims such as “revolutionary,” “viral guaranteed,” or “powered by cutting-edge AI.” Do not promise virality.

## Two creation modes

The README must explain two distinct workflows.

### 1. Long video to shorts

Describe this intended experience:

- Paste a YouTube URL or upload a local video.
- Choose Funny, Serious, Educational, or Hype.
- Transcribe the source.
- Find useful short-form moments.
- Cut on word, sentence, and silence boundaries instead of cutting mid-sentence.
- Reframe for vertical video.
- Burn in word-by-word subtitles.
- Add relevant timed images or GIFs when enabled.
- Download one clip or every completed clip as a ZIP.

### 2. Script to original video

Describe the script workflow:

- Paste or upload a script.
- The configured LLM analyses and divides it into visual narration beats.
- Approximately every 2–3 seconds, or at a natural phrase boundary, a relevant image, GIF, poster, advertisement, or library asset can appear.
- ElevenLabs can optionally generate narration.
- Subtitles are generated and burned into the finished video.
- If ElevenLabs is missing or fails, the job must continue using the available fallback or without that optional voice step.
- The workflow produces a new video rather than clips from an existing source.

If script-to-video is not yet implemented, place it under a clearly labelled `In development` or `Roadmap` section. Do not put it in the “available now” feature list.

## Standout contextual visual feature

Give this feature a concise, understandable section near the top:

S6_cut uses timed subtitle/transcript context to select relevant visuals. If the speaker mentions the Beatles, for example, the app can select Beatles-related imagery and place it over the video at the relevant moment. The user should not need to manually search for every visual.

Explain that:

- Local library assets are searched first.
- Optional web images/GIFs may be used when enabled.
- Visuals are timed to words or semantic phrases.
- Users should be able to review, replace, block, or remove automatic selections.
- Externally sourced assets may carry licensing or attribution requirements; S6_cut must not imply that every web image is automatically free to reuse.

If this feature is planned rather than working, label it accordingly.

## Local asset library

Include a dedicated section explaining the intended Library:

- Users add images, GIFs, posters, logos, advertisements, products, and other reusable assets.
- Users label/tag what each asset represents.
- Assets may be marked Automatic, Preferred, Required, or Blocked.
- During video generation, S6_cut searches the library for labels relevant to the current sentence or narration beat.
- Ads and posters can be deliberately inserted through rules rather than selected randomly.
- Local library assets are preferred before optional web search.

If the Library is incomplete, identify it as in development.

## Local-first and optional APIs

Make these principles prominent:

- Free and open source.
- No S6_cut account.
- No credits system.
- No S6_cut watermark.
- No artificial usage limits.
- Media processing and storage run on the user's own computer or self-hosted server.
- No dedicated NVIDIA GPU should be required for the standard installation.
- Optional external APIs may process data externally when the user enables them; do not misleadingly say “everything stays local” when an enabled API sends text or audio to a provider.

Explain API behaviour precisely:

- OpenRouter is the preferred single-key option for LLM features.
- A user with only an OpenRouter key should be able to use implemented LLM features.
- ElevenLabs is optional for narration or transcription enhancements.
- Deepgram, Gemini, publishing services, and other integrations are optional where supported.
- Missing optional keys must result in a skipped enhancement or local fallback, not a fatal job error.
- Basic long-video processing should work without a cloud account when the corresponding local fallbacks are implemented.

Use a simple feature matrix like:

| Configuration | Expected behaviour |
|---|---|
| No API keys | Local processing and local fallbacks |
| OpenRouter only | LLM features through OpenRouter; unavailable voice extras skipped |
| OpenRouter + ElevenLabs | LLM analysis plus optional generated narration |
| Additional providers | Optional enhancements selected in Settings |

Only claim combinations that the current code actually supports. Mark the rest as target behaviour.

## TrueNAS, Portainer, and PWA

Present Docker self-hosting as a primary deployment method, especially for TrueNAS and Portainer.

The README should have:

- A normal CPU-first Docker Compose quick start.
- A short Portainer stack section.
- A short TrueNAS custom-app section or a link to a checked-in detailed deployment guide.
- Persistent volume expectations for configuration, projects, videos, cache, and the asset library.
- LAN/reverse-proxy security guidance.
- A clear statement that optional GPU acceleration is not required.

Explain that the frontend is intended to be installable as a PWA. If the manifest/service worker is not currently present and verified, describe PWA installation as planned rather than completed.

## Required README structure

Use this ordering unless repository evidence requires a small adjustment:

1. Official S6_cut logo and product name
2. One-sentence value proposition
3. Three-step workflow: Drop → Pick a style → Download ZIP
4. Honest project-status callout
5. Available now
6. Product vision / In development
7. Long video to shorts
8. Script to video
9. Context-aware images and GIFs
10. Asset Library
11. Local-first and optional API behaviour
12. Screenshots or a short demo area, using real assets only
13. Quick start with CPU-only Docker Compose
14. TrueNAS and Portainer
15. Configuration and provider matrix
16. Architecture and technology stack
17. Security and privacy
18. Development/testing commands
19. Roadmap with checkboxes backed by repository evidence
20. Contributing and issue links
21. Licence and third-party notices

Put implementation-heavy details inside collapsible `<details>` sections where possible so the landing page remains approachable.

## Branding and assets

Use only the S6_cut product identity.

- Display name: `S6_cut`
- Repository: `https://github.com/carmelo-schepis/S6_CUT`
- Issues: `https://github.com/carmelo-schepis/S6_CUT/issues`
- Clone URL: `https://github.com/carmelo-schepis/S6_CUT.git`
- README logo: use the existing official `dashboard/public/s6-cut-logo.png` if it is present and renders correctly.
- Do not use ClippyMe names, logos, badges, repository links, package commands, environment prefixes, or marketing copy.
- Do not use OpenShorts or another upstream project as the main product identity.

Do not remove factually required third-party names such as OpenRouter, ElevenLabs, ffmpeg, FastAPI, React, or Docker.

## Licence presentation

MIT is the name of the open-source licence and does not imply an affiliation with the Massachusetts Institute of Technology.

- A repository licence badge may remain if it points to `carmelo-schepis/S6_CUT`.
- Keep the README licence section short and product-neutral.
- Do not present ClippyMe as the current product, maintainer, or owner anywhere in the README.
- Do not delete legally required upstream copyright notices from the root licence merely for branding reasons.
- The root `LICENSE` should retain applicable upstream MIT notices and may add `Copyright (c) 2026 Carmelo Schepis` for original S6_cut contributions if accurate.
- Put unavoidable third-party legal notices in a dedicated `THIRD_PARTY_NOTICES.md`, away from the product introduction.
- Do not claim copyright over code the S6_cut author did not create.

This task may update README links to `LICENSE` and `THIRD_PARTY_NOTICES.md`, but it must not fabricate a new copyright holder or silently remove an upstream notice.

## Writing requirements

- Use Australian or neutral international English consistently.
- Keep paragraphs short.
- Prefer concrete behaviour over slogans.
- Explain technical terms on first use.
- Avoid emojis except where they materially improve the three-step workflow.
- Do not use “desktop app” alone in a way that implies a native executable if the product is presently browser-based. Use “desktop-style Progressive Web App” and state its verified installation status.
- Do not claim “everything runs locally” without the external-API qualification.
- Do not claim “unlimited” in relation to external API quotas. Say S6_cut imposes no artificial limits; providers may have their own quotas and charges.
- Do not claim “no watermark” for assets returned by external providers unless verified. Say S6_cut adds no product watermark.

## Repository verification

Before writing, inspect the current implementation and classify each feature as:

- `Available`
- `Partial`
- `In development`
- `Planned`

At minimum verify:

- URL and file upload
- Style selector
- ZIP-all download
- OpenRouter configuration and provider use
- Keyless processing
- ElevenLabs failure fallback
- Script upload/generation
- Timed images/GIF overlays
- Asset Library
- PWA manifest/service worker/installability
- CPU-only default build
- TrueNAS/Portainer instructions

Use those findings to write the project-status and roadmap sections. Do not alter checkboxes merely to make the project appear more complete.

After rewriting:

1. Check every relative link and anchor.
2. Confirm the logo renders from GitHub.
3. Confirm every badge references the canonical repository.
4. Search the README case-insensitively for old product branding and old repository owners.
5. Confirm installation commands use the actual default branch, package name, Compose filenames, ports, and environment variables.
6. Render or preview the Markdown and fix malformed HTML/tables/details blocks.
7. Report which product capabilities were marked available, partial, in development, or planned and the repository evidence for each.

## Desired opening example

Use this as direction, not mandatory verbatim text:

```markdown
# S6_cut

**Turn one long video into a folder of ready-to-post shorts—locally, without accounts, credits, watermarks, or artificial limits.**

### Three steps

1. **Drop** a YouTube link or video file.
2. **Pick a style:** Funny, Serious, Educational, or Hype.
3. **Download** every finished clip as a ZIP.

S6_cut transcribes speech, finds clean sentence boundaries, creates vertical clips, and burns in word-by-word subtitles. Its context-aware visual system is designed to match spoken phrases with relevant images, GIFs, memes, posters, and assets from your own library.
```

Follow this immediately with a conspicuous status box distinguishing working features from the product vision.

## Definition of done

The README update is complete when:

- A new visitor understands Drop → Pick a style → Download ZIP within 30 seconds.
- Both long-video and script-video workflows are explained.
- OpenRouter-only use and graceful optional-API fallbacks are central to the product direction.
- Contextual timed visuals and the labelled local asset library are clearly explained.
- Local-first, PWA, CPU-only, TrueNAS, and Portainer goals are visible.
- No unfinished functionality is represented as completed.
- S6_cut is the only first-party product brand in normal README copy.
- Repository links, logo, commands, badges, anchors, licensing link, and deployment instructions are correct.
- The README remains useful to creators, self-hosters, contributors, and developers without overwhelming the opening section.

Return the completed README diff plus a short evidence table explaining why every major feature was classified as available, partial, in development, or planned.
