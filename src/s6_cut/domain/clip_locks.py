"""Per-clip async mutex shared by the post-hoc reframe and compose paths.

Both paths write deterministic filenames derived only from the clip index
(``<clip>.reframe.tmp.mp4``, ``composed_*_{i}.mp4``, and the final clip file
itself), so two concurrent requests for the same clip clobber each other's
in-flight files: a double-clicked "Apply & reprocess" spawns two
``--reframe-only`` subprocesses racing ``os.replace`` on one tmp path, and an
overlapping Download + Publish(compose_first) can delete an intermediate the
other request is still reading. Serialising per ``(job_dir, clip_index)``
fixes both; different clips stay fully parallel.

Mirrors ``smartcut._CLIP_LOCKS`` (the threading version) including its
refcounted registry — eviction can never hand two waiters different locks for
one key — but is built on ``asyncio.Lock`` because every caller is a
coroutine and must not block the event loop (or a thread-pool worker) while
waiting. No guard lock is needed: all registry mutation happens between
awaits on the single event loop thread.
"""
import asyncio
import contextlib
import os

# key -> [asyncio.Lock, refcount]
_LOCKS: dict = {}


@contextlib.asynccontextmanager
async def clip_lock(job_dir: str, clip_index: int):
    """Serialise reframe/compose work on one clip: ``async with clip_lock(...)``."""
    key = (os.path.abspath(job_dir), int(clip_index))
    entry = _LOCKS.get(key)
    if entry is None:
        entry = [asyncio.Lock(), 0]
        _LOCKS[key] = entry
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if entry[1] <= 0:
            _LOCKS.pop(key, None)
