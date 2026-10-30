# Contributor guidance

Make the smallest complete change that solves the task. Read the touched code and its callers, tests, and project guidance before editing; preserve existing behavior beyond the requested scope.

Follow established project patterns and dependencies. Do not add a dependency for a small change. Keep validation, error handling, security, accessibility, and useful test coverage. Never weaken the contracts in [DO-NOT-CHANGE/INVARIANTS.md](DO-NOT-CHANGE/INVARIANTS.md); update affected callers and focused tests together.

Run the narrowest relevant checks and report what you ran, what you did not run, and any remaining risk.

Guidance adapted from [Ponytail](https://github.com/DietrichGebert/ponytail), reviewed at commit `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`.
