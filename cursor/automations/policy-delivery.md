## Delivery policy (required)
- If you change tracked code or config, you MUST open a non-draft GitHub PR before ending the run.
- Before opening the PR, run the repo's verification: follow AGENTS.md / README / package.json scripts — at minimum lint, typecheck, unit tests, and any targeted tests for your change (e.g. npm test, pytest, vitest). Paste command output summaries into the PR body.
- Use branch name prefix cursor/ and push to origin. Do not merge.
- If investigation finds no safe fix, do NOT open a PR; report findings only.