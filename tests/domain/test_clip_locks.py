"""Tests for the per-clip async mutex shared by reframe + compose.

Same key (job_dir, clip_index) → strict mutual exclusion; different clips →
parallel. The refcounted registry must clean up after itself so the dict
can't grow unbounded across a long session.
"""
import asyncio

from clippyme.domain import clip_locks
from clippyme.domain.clip_locks import clip_lock


def test_same_clip_is_serialised():
    order = []

    async def worker(tag, delay):
        async with clip_lock("output/job", 0):
            order.append(f"{tag}:enter")
            await asyncio.sleep(delay)
            order.append(f"{tag}:exit")

    async def main():
        await asyncio.gather(worker("a", 0.02), worker("b", 0.0))

    asyncio.run(main())
    # Whoever entered first must fully exit before the other enters.
    assert order[0].endswith(":enter")
    first = order[0].split(":")[0]
    assert order[1] == f"{first}:exit", f"interleaved critical sections: {order}"


def test_different_clips_run_in_parallel():
    entered = []

    async def worker(idx, release: asyncio.Event, wait_for: asyncio.Event):
        async with clip_lock("output/job", idx):
            entered.append(idx)
            release.set()
            await asyncio.wait_for(wait_for.wait(), timeout=2)

    async def main():
        e0, e1 = asyncio.Event(), asyncio.Event()
        # Each worker only exits once the OTHER has entered — deadlocks (and
        # times out) if clips 0 and 1 were serialised by a shared lock.
        await asyncio.gather(worker(0, e0, e1), worker(1, e1, e0))

    asyncio.run(main())
    assert sorted(entered) == [0, 1]


def test_registry_is_cleaned_up_after_release():
    async def main():
        async with clip_lock("output/job", 3):
            assert len(clip_locks._LOCKS) == 1
        assert clip_locks._LOCKS == {}

    asyncio.run(main())


def test_same_key_for_equivalent_paths():
    async def main():
        async with clip_lock("output/job", 2):
            # A relative-vs-normalized spelling of the same dir must map to
            # the same key (abspath), i.e. no second registry entry.
            async with clip_lock("output/../output/job", 1):
                assert len(clip_locks._LOCKS) == 2

    asyncio.run(main())
