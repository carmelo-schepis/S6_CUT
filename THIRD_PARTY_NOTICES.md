# Third-party notices

S6_cut application code in this repository is licensed under the MIT License. It uses third-party packages installed from the locked npm/Python dependency manifests and system packages installed by the container images; their upstream licences apply.

## Behavioural references reviewed

No source code was copied from the reference repositories during this build. The following local resources informed clean implementation at a behavioural/architectural level:

- **ClippyMe** — MIT. Reviewed its local `S6_CUT_TAKEAWAYS.md` plus documented concepts for TextTiling, boundary cleanup, independent clips, job recovery, composition order, QA, and security. The local resource checkout does not expose Git revision metadata; no direct source file was copied.
- **ReelsGenerator** — MIT. Reviewed modular Script/TTS/cache/pacing concepts through `S6_CUT_TAKEAWAYS.md`; no direct source file was copied.
- **ViralMint** — AGPL-3.0. Reviewed provider abstraction, score explainability, storyboard, provider health, and test-taxonomy concepts through `S6_CUT_TAKEAWAYS.md`; no direct source file was copied.
- **VUZA Free AI Video Creator** — MIT. Reviewed resolver fallback and progressive gallery concepts through `S6_CUT_TAKEAWAYS.md`; Pinterest scraping and rights-unknown media behavior were explicitly excluded.
- **AI YouTube Shorts Generator** — reference-only because the supplied copy lacks a verified licence/revision. No code was copied.
- **yt-dlp** — Unlicense/public-domain dedication and third-party component notices in the bundled project. S6_cut installs release `2026.7.4` as a constrained, user-authorised YouTube import dependency and does not vendor its source.

Code licences do not grant rights to source media, downloaded media, models, voices, fonts, or the supplied S6_cut logo. Users must verify their own rights and provider terms.
