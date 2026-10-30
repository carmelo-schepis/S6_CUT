"""Music-only lyric layout, display envelopes and hook-banner geometry.

Everything here is pure: callers inject text measurement and ASS escaping, so
the planner has no dependency on fonts, libass or ``engine.media`` and can be
tested with a deterministic fake measurer. Speech captions never reach this
module; Music dispatch is gated in ``engine.media``.

Timing contract: transcript word times are inputs and are never modified. The
planner only decides *display envelopes* (when a block is on screen and how its
opacity ramps), so caption-editor cues, SRT/VTT sidecars, audio and planning
windows stay exact.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

LYRIC_ANIMATIONS = ("legacy", "slow_fade", "line_crossfade", "word_build")
HOOK_TEXT_FORMATS = ("plain", "white_banner")

# --- Initial tuning values (proposed defaults, tuned against decoded frames) ---
SLOW_FADE_IN = 0.45
SLOW_FADE_OUT = 0.65
CROSSFADE_OVERLAP = 0.60
CROSSFADE_FADE_IN = 0.45  # first block, or a block that follows silence
WORD_RAMP = 0.18
WORD_RAMP_MIN = 0.04
WORD_BUILD_FADE_OUT = 0.50
WORD_BUILD_MIN_FADE_OUT = 0.20  # when the next block follows immediately
READABLE_BLOCK_SECONDS = 1.2  # a block this short gets an end-of-phrase hold
MAX_END_HOLD = 0.8
MIN_READABLE_FRACTION = 0.40  # fully-opaque share of a block's lifetime
INSTRUMENTAL_GAP = 1.2  # beyond this the previous block fades out alone
PAUSE_BREAK = 0.65  # same pause threshold the legacy Music grouping uses
MAX_BLOCK_SECONDS = 6.0
MIN_OVERLAP = 0.04
SENTENCE_END = (".", "!", "?", ",", ";", ":")


@dataclass(frozen=True)
class LyricWord:
    text: str
    start: float
    end: float
    index: int  # position in the caller's word list


@dataclass(frozen=True)
class Layout:
    """Theme-level wrapping rules; fonts and colours live with the renderer."""
    max_rows: int
    max_words_per_row: int
    width_fraction: float
    max_words_per_block: int
    align: str = "center"  # "center" | "left"


@dataclass(frozen=True)
class LyricBlock:
    words: tuple[LyricWord, ...]
    rows: tuple[tuple[int, ...], ...]  # indexes into ``words`` per visual row
    font_size: float  # fitted size for this block (<= the theme base size)

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return max(word.end for word in self.words)


@dataclass(frozen=True)
class WordRamp:
    offset: float  # seconds after the event start
    length: float


@dataclass(frozen=True)
class BlockEnvelope:
    block: LyricBlock
    show_start: float
    show_end: float
    fade_in: float
    fade_out: float
    ramps: tuple[WordRamp, ...] = field(default_factory=tuple)  # word_build only


Measure = Callable[[str, float], float]  # (text, font size) -> rendered width in px


def _ends_phrase(text: str) -> bool:
    return text.rstrip().endswith(SENTENCE_END)


def _fit_rows(words: Sequence[LyricWord], layout: Layout, limit_px: float, size: float, measure: Measure) -> list[list[int]]:
    """Greedy row fill by measured width; every word keeps its order."""
    space = measure(" ", size)
    rows: list[list[int]] = [[]]
    used = 0.0
    for index, word in enumerate(words):
        width = measure(word.text, size)
        needed = width if not rows[-1] else used + space + width
        if rows[-1] and (needed > limit_px or len(rows[-1]) >= layout.max_words_per_row):
            rows.append([])
            needed = width
        rows[-1].append(index)
        used = needed
    return rows


def _fit_block(words: Sequence[LyricWord], layout: Layout, *, base_size: float, min_size: float, limit_px: float,
               max_height: float, line_height: float, rows_cap: int, measure: Measure) -> tuple[list[list[int]], float] | None:
    """Rows and a fitted size for ``words``, or None if they cannot fit ``rows_cap`` rows."""
    size = base_size
    while True:
        rows = _fit_rows(words, layout, limit_px, size, measure)
        widest = max(measure(word.text, size) for word in words)
        too_wide = widest > limit_px and size > 8
        too_tall = len(rows) * size * line_height > max_height
        if len(rows) <= rows_cap and not too_tall and not too_wide:
            return rows, size
        if too_wide and size > 8:
            # A single long word shrinks below the readable minimum rather than
            # leaving the canvas: staying on screen wins over size.
            size = max(8.0, min(size - 1, size * limit_px / widest))
            continue
        if size > min_size:
            size = max(min_size, size - 2)
            continue
        return None


def plan_blocks(words: Iterable[dict], *, layout: Layout, base_size: float, line_height: float, canvas_width: float,
                max_height: float, measure: Measure, min_size_ratio: float = 0.7) -> list[LyricBlock]:
    """Group timed words into stable lyric blocks, once, before any animation.

    Blocks close at punctuation, a pause longer than ``PAUSE_BREAK``, a bounded
    duration or word count, or when the next word would overflow the row/height
    budget (pagination instead of overflow). Every input word lands in exactly
    one block, in order, with its original timing.
    """
    items = [
        LyricWord(" ".join(str(word["text"]).split()), float(word["start"]), float(word["end"]), index)
        for index, word in enumerate(words)
        if str(word.get("text", "")).strip()
    ]
    limit_px = canvas_width * layout.width_fraction
    min_size = base_size * min_size_ratio
    rows_cap = max(1, min(layout.max_rows, int(max_height // max(1.0, min_size * line_height))))
    blocks: list[LyricBlock] = []
    current: list[LyricWord] = []

    def close() -> None:
        nonlocal current
        if not current:
            return
        fitted = _fit_block(current, layout, base_size=base_size, min_size=min_size, limit_px=limit_px,
                            max_height=max_height, line_height=line_height, rows_cap=rows_cap, measure=measure)
        if fitted is None:  # cannot happen for a single word; defensive
            fitted = ([[i] for i in range(len(current))], min_size)
        rows, size = fitted
        blocks.append(LyricBlock(tuple(current), tuple(tuple(row) for row in rows), size))
        current = []

    for word in items:
        if current:
            gap = word.start - current[-1].end
            brk = (
                gap > PAUSE_BREAK
                or _ends_phrase(current[-1].text)
                or len(current) >= layout.max_words_per_block
                or word.end - current[0].start > MAX_BLOCK_SECONDS
            )
            if not brk:
                trial = [*current, word]
                brk = _fit_block(trial, layout, base_size=base_size, min_size=min_size, limit_px=limit_px,
                                 max_height=max_height, line_height=line_height, rows_cap=rows_cap, measure=measure) is None
            if brk:
                close()
        current.append(word)
    close()
    return blocks


def _hold_end(block: LyricBlock, next_start: float | None, duration: float) -> float:
    """Block end plus a readability hold, never reaching into the next block."""
    lifetime = block.end - block.start
    extension = min(MAX_END_HOLD, max(0.0, READABLE_BLOCK_SECONDS - lifetime))
    end = block.end + extension
    if next_start is not None:
        end = min(end, max(block.end, next_start))
    return min(end, duration)


def _clamp_fades(fade_in: float, fade_out: float, lifetime: float) -> tuple[float, float]:
    """Leave at least ``MIN_READABLE_FRACTION`` of the lifetime fully opaque."""
    budget = max(0.0, lifetime * (1.0 - MIN_READABLE_FRACTION))
    total = fade_in + fade_out
    if total > budget and total > 0:
        scale = budget / total
        return fade_in * scale, fade_out * scale
    return fade_in, fade_out


def plan_envelopes(blocks: Sequence[LyricBlock], animation: str, duration: float) -> list[BlockEnvelope]:
    """Display envelopes for ``animation``; blocks never appear before their first word."""
    if animation not in LYRIC_ANIMATIONS or animation == "legacy":
        raise ValueError(f"No envelope planner for lyric animation {animation!r}")
    envelopes: list[BlockEnvelope] = []
    for position, block in enumerate(blocks):
        following = blocks[position + 1] if position + 1 < len(blocks) else None
        preceding = blocks[position - 1] if position else None
        next_start = following.start if following else None
        start = max(0.0, block.start)
        if start >= duration:
            continue
        hold_end = _hold_end(block, next_start, duration)
        if animation == "slow_fade":
            end = min(duration, hold_end + SLOW_FADE_OUT)
            if next_start is not None:
                end = min(end, max(hold_end, next_start))
            fade_in, fade_out = _clamp_fades(SLOW_FADE_IN, SLOW_FADE_OUT, end - start)
            envelopes.append(BlockEnvelope(block, start, end, fade_in, fade_out))
        elif animation == "line_crossfade":
            gap_next = (next_start - block.end) if next_start is not None else None
            crossfades_out = following is not None and gap_next is not None and gap_next <= INSTRUMENTAL_GAP
            gap_prev = (block.start - preceding.end) if preceding is not None else None
            crossfaded_in = preceding is not None and gap_prev is not None and gap_prev <= INSTRUMENTAL_GAP
            fade_in = _crossfade_overlap(preceding, block) if crossfaded_in else CROSSFADE_FADE_IN
            if crossfades_out:
                overlap = _crossfade_overlap(block, following)
                end = min(duration, next_start + overlap)
                fade_out = overlap if overlap >= MIN_OVERLAP else 0.0
                if fade_out == 0.0:
                    end = min(duration, next_start)
            else:
                end = min(duration, hold_end + CROSSFADE_OVERLAP)
                fade_out = min(CROSSFADE_OVERLAP, max(end - hold_end, 0.3 * (end - start)))
            if fade_in < MIN_OVERLAP:
                fade_in = 0.0
            lifetime = max(0.0, end - start)
            if fade_in + fade_out > lifetime:
                scale = lifetime / (fade_in + fade_out)
                fade_in, fade_out = fade_in * scale, fade_out * scale
            envelopes.append(BlockEnvelope(block, start, end, fade_in, fade_out))
        else:  # word_build
            ramps: list[WordRamp] = []
            for index, word in enumerate(block.words):
                onset = max(start, word.start)
                following_onset = block.words[index + 1].start if index + 1 < len(block.words) else None
                length = WORD_RAMP
                if following_onset is not None:
                    length = min(WORD_RAMP, max(WORD_RAMP_MIN, following_onset - onset))
                ramps.append(WordRamp(onset - start, length))
            end = min(duration, hold_end + WORD_BUILD_FADE_OUT)
            if next_start is not None:
                end = min(end, max(hold_end, next_start))
            settled = start + ramps[-1].offset + ramps[-1].length
            # The completed block gets a readable hold before it fades: the fade
            # is as long as the time after the end-hold allows, but never shorter
            # than the minimum nor starting before the last word has settled.
            fade_out = min(WORD_BUILD_FADE_OUT, max(0.0, end - settled), max(WORD_BUILD_MIN_FADE_OUT, end - hold_end))
            fade_out = fade_out if fade_out >= MIN_OVERLAP else 0.0
            envelopes.append(BlockEnvelope(block, start, end, 0.0, fade_out, tuple(ramps)))
    return envelopes


def _crossfade_overlap(outgoing: LyricBlock, incoming: LyricBlock) -> float:
    """Overlap bounded so a third block can never join the crossfade."""
    return max(0.0, min(
        CROSSFADE_OVERLAP,
        0.5 * (incoming.end - incoming.start),
        0.5 * (incoming.start - outgoing.start),
    ))


def _ms(seconds: float) -> int:
    return max(0, round(seconds * 1000))


def _alpha(value: int) -> str:
    return f"&H{max(0, min(255, value)):02X}&"


def block_event(
    envelope: BlockEnvelope, *, animation: str, ass_time: Callable[[float], str], escape: Callable[[str], str],
    position: tuple[int, int], align: str, primary: str, highlight: str | None, outline_alpha: int, layer: int = 10,
    style: str = "Caption", extra_tags: str = "",
) -> str:
    """One ASS dialogue line carrying the whole block.

    A single event keeps every word at its fixed measured position: word-build
    words not yet revealed are transparent rather than absent, so nothing
    reflows when a new word arrives.
    """
    block = envelope.block
    show = envelope.show_start
    x, y = position
    anchor = r"\an4" if align == "left" else r"\an5"
    tags = [anchor, r"\q2", rf"\pos({x},{y})", rf"\fs{max(1, round(block.font_size))}"]
    if extra_tags:
        tags.append(extra_tags)
    if animation != "word_build" and (envelope.fade_in > 0 or envelope.fade_out > 0):
        tags.append(rf"\fad({_ms(envelope.fade_in)},{_ms(envelope.fade_out)})")
    elif animation == "word_build" and envelope.fade_out > 0:
        tags.append(rf"\fad(0,{_ms(envelope.fade_out)})")
    lines = []
    for row in block.rows:
        parts = []
        for index in row:
            word = block.words[index]
            text = escape(word.text)
            prefix = ""
            if animation == "word_build":
                ramp = envelope.ramps[index]
                begin = _ms(ramp.offset)
                finish = begin + max(1, _ms(ramp.length))
                prefix += rf"\1a&HFF&\3a&HFF&\t({begin},{finish},\1a&H00&\3a{_alpha(outline_alpha)})"
            if highlight and highlight != primary:
                begin = _ms(max(0.0, word.start - show))
                finish = _ms(max(0.0, word.end - show))
                prefix += rf"\1c{primary}\t({begin},{begin + 1},\1c{highlight})\t({max(finish, begin + 2)},{max(finish, begin + 2) + 1},\1c{primary})"
            parts.append((("{" + prefix + "}") if prefix else "") + text)
        lines.append(" ".join(parts))
    body = r"\N".join(lines)
    return f"Dialogue: {layer},{ass_time(envelope.show_start)},{ass_time(envelope.show_end)},{style},,0,0,0,,{{{''.join(tags)}}}{body}"


# --- White hook banner -------------------------------------------------------

@dataclass(frozen=True)
class BannerPlan:
    lines: tuple[str, ...]
    font_size: int
    top: int
    bottom: int  # exclusive; this is the top edge of the fitted footage
    centre_y: float


def wrap_text(text: str, size: float, limit_px: float, measure: Measure) -> list[str]:
    """Wrap on spaces by measured width; an over-wide single word gets its own line."""
    words = text.split()
    lines: list[str] = []
    current = ""
    space = measure(" ", size)
    used = 0.0
    for word in words:
        width = measure(word, size)
        if current and used + space + width > limit_px:
            lines.append(current)
            current, used = word, width
        else:
            current = f"{current} {word}" if current else word
            used = used + space + width if used else width
    if current:
        lines.append(current)
    return lines


def plan_hook_banner(text: str, *, canvas_width: int, footage_top: int, base_size: int, min_size: int, line_height: float,
                     measure: Measure, available_height: int | None = None, strict: bool = False,
                     pad_x_ratio: float = 0.06, pad_y_ratio: float = 0.35) -> BannerPlan | None:
    """Fit ``text`` into a full-width strip that ends exactly where the footage begins.

    Prefers two lines, allows a measured third for long hooks, and shrinks the
    font down to ``min_size`` before giving up on a line count. If even that
    cannot fit the headroom above the footage, a non-strict plan keeps shrinking
    (down to 8 px) so the full text still shows; the text is never truncated.
    ``strict`` instead returns None, letting the caller choose another fallback.
    ``available_height`` limits how far above the footage the strip may reach.
    """
    cleaned = " ".join(text.split())
    room = footage_top if available_height is None else min(footage_top, available_height)
    if not cleaned or footage_top <= 0 or room <= 0:
        return None
    limit = canvas_width * (1 - 2 * pad_x_ratio)

    def strip_height(count: int, size: float) -> float:
        return count * size * line_height + 2 * size * pad_y_ratio

    chosen: tuple[list[str], int] | None = None
    for max_lines in (2, 3):
        for size in range(base_size, min_size - 1, -2):
            lines = wrap_text(cleaned, size, limit, measure)
            if len(lines) <= max_lines and strip_height(len(lines), size) <= room:
                chosen = (lines, size)
                break
        if chosen:
            break
    if chosen is None:
        if strict:
            return None
        size = min_size
        while True:
            lines = wrap_text(cleaned, size, limit, measure)
            if strip_height(len(lines), size) <= room or size <= 8:
                chosen = (lines, size)
                break
            size -= 1
    lines, size = chosen
    height = min(room, math.ceil(strip_height(len(lines), size)))
    top = footage_top - height
    return BannerPlan(tuple(lines), size, top, footage_top, top + height / 2)
