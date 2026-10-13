# Full backend suite

- Command: `python -m pytest engine/tests -q -p no:cacheprovider --basetemp=/app/data/tmp/pytest`
- Runtime: isolated feature-branch engine image; temporary data on SSD-backed `/var/tmp` to avoid the saturated Docker/worktree HDD.
- Result: **658 passed**, 1 `StarletteDeprecationWarning`, in 469.76s (7m49s).
- Exit status: 0.
