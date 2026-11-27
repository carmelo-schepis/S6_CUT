## Delivery policy (required)

Every run must **ship value**: implement one focused improvement, **test it**, and open **exactly one non-draft** GitHub pull request before the run ends. You are expected to produce **lots of PRs** over time—each run leaves a concrete, reviewable change on a `cursor/` branch. Do not merge.

### Before you start
1. List **open pull requests** on this repo (especially `cursor/*` and `automation/*`). Do not duplicate an in-flight fix; pick a different improvement in the same theme or extend only if explicitly needed.
2. Read `AGENTS.md`, `README.md`, and `package.json` scripts to learn how this repo is verified.

### What to ship (match this automation’s theme)
Pick **one** small, high-leverage change that fits the automation you were triggered as:
- **Fix CI failures** — fix a failing check, flake, misconfiguration, or **speed up CI** (cache, parallelization, slimmer jobs, faster install) without weakening required gates.
- **Scan codebase for vulnerabilities** — a **security hardening** fix: dependency bump with compatibility verified, safer defaults, input validation, secret handling, or a targeted guard; not noise-only bumps.
- **Monitor environment build health** — **build or Cloud Agent environment** speedups: faster `install`, slimmer deps, build fixes, or clearer failure signals so builds stay green.
- **Monitor engineering invariants** — an **invariant, lint rule, test, or CI guard** that prevents regressions; or a small fix when an invariant is already failing.
- **Find critical bugs** — a **real bug fix** with a regression test when feasible.

If the primary scan finds nothing obvious, **still open a PR**: choose the most valuable small improvement **in that same theme** (performance, reliability, dead code removal, missing test, slow step). No cosmetic-only changes, no churn, no drive-by refactors.

### Implementation and testing (mandatory before PR)
1. Make the **smallest correct diff** that delivers the improvement.
2. Run verification appropriate to the change (at minimum what `npm run check` covers when touching the main app; `pytest` for engine/python; add targeted tests for bugs/invariants). **Do not open a PR if tests fail**—fix or narrow the change until they pass.
3. Summarize **commands run and pass/fail** in the PR body (short excerpts, not walls of logs).

### Pull request requirements
1. Branch: `cursor/<short-descriptive-name>`; push to `origin`.
2. Open a **non-draft** PR targeting `main`.
3. PR body must include:
   - **What changed**
   - **Why it helps** (effectiveness, efficiency, security, reliability)
   - **Test evidence** (commands + results)
   - **Theme** (which automation goal this satisfies)
4. Do not merge, force-push over others’ work, or open multiple PRs in one run.

### Completion criterion
The run is **not complete** until the PR is created and pushed. Failing to open a tested PR is a failed run.