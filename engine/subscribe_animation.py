"""Versioned subscribe animation configuration and output-relative schedule."""

from collections.abc import Mapping
from math import isfinite
from pathlib import Path

ANIMATION_DURATION_SECONDS = 4.0
SCHEDULE_VERSION = 1
ANIMATION_ASSET = Path(__file__).parent / "assets" / "subscribe-click.mov"


def schedule_subscribe_animation(
    duration: float,
    *,
    content_format: str = "short",
    config: Mapping[str, object] | None = None,
    animation_duration: float = ANIMATION_DURATION_SECONDS,
) -> tuple[tuple[float, float], ...]:
    """Return deterministic ``(start, cycle_duration)`` intervals in output seconds.

    Missing or unknown-version settings intentionally disable the feature for
    legacy records. Every returned interval is clamped to the finished output.
    Short form uses one end-relative occurrence. Long form gets a midpoint and
    an end-minus-30-second occurrence unless those are too close, in which case
    one occurrence is placed in the final five seconds.
    """
    if not isinstance(config, Mapping) or config.get("enabled") is not True:
        return ()
    if config.get("version") != SCHEDULE_VERSION:
        return ()
    try:
        length = float(duration)
        cycle = float(animation_duration)
        lead = config.get("short_form_lead_seconds", 5)
    except (TypeError, ValueError, OverflowError):
        return ()
    if not isfinite(length) or not isfinite(cycle) or length <= 0 or cycle <= 0:
        return ()
    if type(lead) is not int or lead not in {5, 10}:
        return ()
    cycle = min(cycle, length)

    if content_format != "long":
        start = max(0.0, length - lead)
        occurrence_duration = min(cycle, length - start)
        return ((round(start, 3), round(occurrence_duration, 3)),)

    def bounded(start: float) -> tuple[float, float]:
        start = min(max(0.0, start), length)
        return round(start, 3), round(min(cycle, length - start), 3)

    if length < cycle:
        return (bounded(max(0.0, length - min(5.0, length))),)

    occurrences = sorted((bounded(length / 2), bounded(length - 30.0)))
    first, second = occurrences
    gap = second[0] - (first[0] + first[1])
    if gap < 2.0:
        return (bounded(max(0.0, length - min(5.0, length))),)
    return tuple(occurrences)
