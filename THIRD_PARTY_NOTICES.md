# Third-party notices

This repository uses third-party packages installed from the locked npm/Python dependency manifests and system packages installed by the container images; their upstream licences apply.

## Behavioural references reviewed

- **MoneyPrinterTurbo** — MIT, commit `1d1d0d25b3c27609be4683c0cf3dc08c5821788a`. Topic-to-video stages (reviewable script, material keywords, narration, captions, composition, and bounded variants) were used as behavioral reference only; no source code, music, fonts, logos, or demo assets were copied.

No source code was copied from the reference repositories during this build. The following local resources informed clean implementation at a behavioural/architectural level:

- **ClippyMe** — MIT. Reviewed its local `S6_CUT_TAKEAWAYS.md` plus documented concepts for TextTiling, boundary cleanup, independent clips, job recovery, composition order, QA, and security. The local resource checkout does not expose Git revision metadata; no direct source file was copied.
- **ReelsGenerator** — MIT. Reviewed modular Script/TTS/cache/pacing concepts through `S6_CUT_TAKEAWAYS.md`; no direct source file was copied.
- **ViralMint** — AGPL-3.0. Reviewed provider abstraction, score explainability, storyboard, provider health, and test-taxonomy concepts through `S6_CUT_TAKEAWAYS.md`; no direct source file was copied.
- **VUZA Free AI Video Creator** — MIT. Reviewed resolver fallback and progressive gallery concepts through `S6_CUT_TAKEAWAYS.md`; Pinterest scraping and rights-unknown media behavior were explicitly excluded.
- **AI YouTube Shorts Generator** — reference-only because the supplied copy lacks a verified licence/revision. No code was copied.
- **yt-dlp** — Unlicense/public-domain dedication and third-party component notices in the bundled project. S6_cut installs release `2026.7.4` as a constrained, user-authorised YouTube import dependency and does not vendor its source.

- **Anton**, **Archivo Black**, **Barlow**, and **Lora** — SIL Open Font License 1.1. Vendored under `engine/fonts/` (each family with its own `OFL.txt`) and installed into the engine image so burned-in captions render in a real display face instead of a synthetically emboldened fallback. Unmodified upstream files from the Google Fonts repository; Reserved Font Names are untouched.

Code licences do not grant rights to source media, downloaded media, models, voices, fonts, or the supplied S6_cut logo. Users must verify their own rights and provider terms.
