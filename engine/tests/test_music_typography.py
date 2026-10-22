"""Pure planner tests: stable lyric blocks, display envelopes and banner geometry."""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from engine import music_typography as mt
from engine.media import caption_words_for_clip, write_music_ass

LAYOUT = mt.Layout(max_rows=3, max_words_per_row=4, width_fraction=0.78, max_words_per_block=12)


def measure(text: str, size: float) -> float:
    """Deterministic fake face: every character is half an em wide."""
    return len(text) * size * 0.5


def words_from(spec: list[tuple[str, float, float]]) -> list[dict]:
    return [{"text": text, "start": start, "end": end} for text, start, end in spec]


def plan(spec, *, layout: mt.Layout = LAYOUT, width: int = 1080, base: int = 100, height: float = 960):
    return mt.plan_blocks(words_from(spec), layout=layout, base_size=base, line_height=1.0, canvas_width=width, max_height=height, measure=measure)


SONG = [
    ("do", 0.6, 0.9), ("you", 0.95, 1.2), ("think", 1.25, 1.7), ("that", 1.75, 2.0), ("i've", 2.05, 2.4), ("forgotten,", 2.45, 3.0),
    ("about", 3.1, 3.5), ("the", 3.55, 3.7), ("way", 3.75, 4.2), ("we", 4.25, 4.4), ("were", 4.45, 4.9),
    ("alone", 8.0, 8.8), ("tonight", 8.9, 9.6),
]


def test_every_timed_word_is_kept_once_in_order_with_original_timing() -> None:
    blocks = plan(SONG)
    flat = [word for block in blocks for word in block.words]
    assert [(w.text, w.start, w.end) for w in flat] == SONG
    assert [w.index for w in flat] == list(range(len(SONG)))
    # Rows reference each word of a block exactly once.
    for block in blocks:
        used = sorted(index for row in block.rows for index in row)
        assert used == list(range(len(block.words)))


def test_blocks_break_at_punctuation_pauses_and_measured_width() -> None:
    blocks = plan(SONG)
    texts = [" ".join(w.text for w in block.words) for block in blocks]
    assert texts == ["do you think that i've forgotten,", "about the way we were", "alone tonight"]
    # A pause alone splits a block even without punctuation.
    spec = [("one", 0.0, 0.3), ("two", 0.4, 0.7), ("three", 2.0, 2.4)]
    assert [len(b.words) for b in plan(spec)] == [2, 1]
    # A narrow canvas forces pagination into several blocks instead of overflow.
    narrow = plan([(f"w{i}", i * 0.3, i * 0.3 + 0.25) for i in range(10)], width=300)
    assert len(narrow) > 1 and all(len(b.rows) <= LAYOUT.max_rows for b in narrow)


def test_repeated_lyrics_stay_separate_independent_blocks() -> None:
    spec = [("la", 0.0, 0.3), ("la,", 0.35, 0.7), ("la", 3.0, 3.3), ("la,", 3.35, 3.7)]
    blocks = plan(spec)
    assert len(blocks) == 2
    assert [w.start for w in blocks[1].words] == [3.0, 3.35]
    assert blocks[0].words[0].index == 0 and blocks[1].words[0].index == 2


def test_fit_never_leaves_the_canvas_for_long_words_or_tall_stacks() -> None:
    giant = plan([("supercalifragilisticexpialidocious" * 2, 0.0, 1.0)], width=400)
    assert giant[0].font_size < 100
    assert measure(giant[0].words[0].text, giant[0].font_size) <= 400 * LAYOUT.width_fraction + 1
    stack = mt.Layout(max_rows=6, max_words_per_row=1, width_fraction=0.5, max_words_per_block=8)
    tall = plan([(f"word{i}", i * 0.3, i * 0.3 + 0.25) for i in range(8)], layout=stack, height=300, base=100)
    for block in tall:
        assert len(block.rows) * block.font_size <= 300 + 1e-6


def test_ass_text_and_timing_inputs_are_not_rewritten_by_planning() -> None:
    inputs = words_from(SONG)
    before = [dict(word) for word in inputs]
    blocks = mt.plan_blocks(inputs, layout=LAYOUT, base_size=100, line_height=1.0, canvas_width=1080, max_height=960, measure=measure)
    mt.plan_envelopes(blocks, "line_crossfade", 12)
    assert inputs == before


@pytest.mark.parametrize("animation", ["slow_fade", "line_crossfade", "word_build"])
def test_blocks_never_show_before_their_first_word_and_stay_inside_the_clip(animation: str) -> None:
    for duration in (9.9, 12.0):
        envelopes = mt.plan_envelopes(plan(SONG), animation, duration)
        assert envelopes
        for envelope in envelopes:
            assert envelope.show_start >= envelope.block.start - 1e-9
            assert envelope.show_start < envelope.show_end <= duration + 1e-9
            assert envelope.fade_in >= 0 and envelope.fade_out >= 0
            assert envelope.fade_in + envelope.fade_out <= (envelope.show_end - envelope.show_start) + 1e-9


@pytest.mark.parametrize("animation", ["slow_fade", "line_crossfade", "word_build"])
def test_at_most_two_blocks_are_ever_visible_together(animation: str) -> None:
    spec = [(f"w{i}", i * 0.5, i * 0.5 + 0.45) for i in range(40)]
    envelopes = mt.plan_envelopes(plan(spec, layout=mt.Layout(2, 3, 0.78, 3)), animation, 20.0)
    points = sorted({e.show_start for e in envelopes} | {e.show_end for e in envelopes})
    for left, right in zip(points, points[1:]):
        mid = (left + right) / 2
        assert sum(1 for e in envelopes if e.show_start <= mid < e.show_end) <= 2


def test_slow_fade_uses_the_documented_ramps_and_keeps_forty_percent_readable() -> None:
    envelopes = mt.plan_envelopes(plan(SONG), "slow_fade", 12)
    first = envelopes[0]
    assert math.isclose(first.fade_in, mt.SLOW_FADE_IN) and math.isclose(first.fade_out, mt.SLOW_FADE_OUT)
    for envelope in envelopes:
        assert envelope.fade_in + envelope.fade_out <= 0.6 * (envelope.show_end - envelope.show_start) + 1e-9
    # A very short block clamps both ramps instead of fading through its whole life.
    short = mt.plan_envelopes(plan([("hey", 1.0, 1.2)]), "slow_fade", 5)[0]
    assert short.fade_in + short.fade_out <= 0.6 * (short.show_end - short.show_start) + 1e-9
    # No overlap: each slow-fade block ends no later than the next begins.
    for current, following in zip(envelopes, envelopes[1:]):
        assert current.show_end <= following.show_start + 1e-9


def test_line_crossfade_overlaps_adjacent_blocks_without_early_incoming_words() -> None:
    envelopes = mt.plan_envelopes(plan(SONG), "line_crossfade", 12)
    first, second = envelopes[0], envelopes[1]
    # The incoming block starts at its first word, and the outgoing one is still
    # on screen, fading, at that same moment.
    assert second.show_start == pytest.approx(3.1)
    assert first.show_end > second.show_start
    overlap = first.show_end - second.show_start
    assert overlap <= mt.CROSSFADE_OVERLAP + 1e-9
    assert first.fade_out == pytest.approx(overlap) and second.fade_in == pytest.approx(overlap)
    # Across the long instrumental gap the old block fades alone: no overlap.
    third = envelopes[2]
    assert third.show_start == pytest.approx(8.0)
    assert second.show_end < third.show_start
    assert third.fade_in == pytest.approx(mt.CROSSFADE_FADE_IN)


def test_instrumental_gap_stays_empty_and_clip_start_is_not_invented() -> None:
    for animation in ("slow_fade", "line_crossfade", "word_build"):
        envelopes = mt.plan_envelopes(plan(SONG), animation, 12)
        assert envelopes[0].show_start == pytest.approx(0.6)  # silence before the first word
        # nothing is on screen in the middle of the 4.9–8.0 instrumental gap
        assert not any(e.show_start <= 6.5 < e.show_end for e in envelopes)


def test_word_build_reveals_each_word_at_its_onset_and_never_early() -> None:
    envelopes = mt.plan_envelopes(plan(SONG), "word_build", 12)
    for envelope in envelopes:
        assert len(envelope.ramps) == len(envelope.block.words)
        for word, ramp in zip(envelope.block.words, envelope.ramps):
            assert envelope.show_start + ramp.offset == pytest.approx(max(envelope.show_start, word.start))
            assert mt.WORD_RAMP_MIN - 1e-9 <= ramp.length <= mt.WORD_RAMP + 1e-9
        # Words are revealed in order; earlier ones are never re-laid-out.
        offsets = [r.offset for r in envelope.ramps]
        assert offsets == sorted(offsets)
        assert envelope.fade_in == 0


def test_word_build_ramp_is_clamped_for_fast_words_and_ends_before_the_fade() -> None:
    fast = [("a", 0.0, 0.05), ("b", 0.06, 0.1), ("c", 0.11, 0.15), ("d", 0.16, 0.8)]
    envelope = mt.plan_envelopes(plan(fast), "word_build", 5)[0]
    for ramp, nxt in zip(envelope.ramps, envelope.ramps[1:]):
        assert ramp.offset + ramp.length <= nxt.offset + mt.WORD_RAMP_MIN + 1e-9
    settled = envelope.show_start + envelope.ramps[-1].offset + envelope.ramps[-1].length
    assert envelope.show_end - envelope.fade_out >= settled - 1e-9


def test_end_hold_is_bounded_and_clip_end_clamps_everything() -> None:
    held = mt.plan_envelopes(plan([("hey", 1.0, 1.2)]), "word_build", 10)[0]
    assert held.show_end - 1.2 <= mt.MAX_END_HOLD + mt.WORD_BUILD_FADE_OUT + 1e-9
    clipped = mt.plan_envelopes(plan([("hey", 1.0, 1.2), ("you", 1.25, 1.6)]), "line_crossfade", 1.5)
    assert all(e.show_end <= 1.5 + 1e-9 for e in clipped)
    # A block that starts at or beyond the clip end is dropped, not rendered.
    assert mt.plan_envelopes(plan([("late", 5.0, 5.4)]), "slow_fade", 5.0) == []


def test_nonzero_clip_offsets_are_converted_to_local_time_before_planning() -> None:
    source = words_from([("before", 8.0, 9.0), ("start", 9.8, 10.4), ("inside", 10.5, 11.0), ("end", 11.8, 12.4), ("after", 13.0, 13.5)])
    local = caption_words_for_clip(source, 10.0, 12.0)
    assert [(w["text"], round(w["start"], 6), round(w["end"], 6)) for w in local] == [("start", 0.0, 0.4), ("inside", 0.5, 1.0), ("end", 1.8, 2.0)]
    blocks = plan([(w["text"], w["start"], w["end"]) for w in local])
    envelopes = mt.plan_envelopes(blocks, "line_crossfade", 2.0)
    assert envelopes[0].show_start == pytest.approx(0.0)
    assert all(0 <= e.show_start and e.show_end <= 2.0 + 1e-9 for e in envelopes)


def test_block_events_escape_text_and_carry_single_event_fades() -> None:
    blocks = plan([("{raw}", 0.0, 0.5), ("back\\slash", 0.6, 1.0)])
    envelope = mt.plan_envelopes(blocks, "slow_fade", 4)[0]
    line = mt.block_event(
        envelope, animation="slow_fade", ass_time=lambda v: f"{v:.2f}", escape=lambda t: t.replace("{", r"\{"),
        position=(540, 960), align="center", primary="&H00FFFFFF&", highlight=None, outline_alpha=0x80,
    )
    assert r"\fad(" in line and r"\an5\q2" in line and r"\{raw}" in line
    build = mt.block_event(
        mt.plan_envelopes(blocks, "word_build", 4)[0], animation="word_build", ass_time=lambda v: f"{v:.2f}", escape=lambda t: t,
        position=(540, 960), align="left", primary="&H00FFFFFF&", highlight=None, outline_alpha=0x99,
    )
    assert r"\an4" in build and r"\1a&HFF&" in build and r"\3a&H99&" in build and build.count(r"\t(") == 2


# --- hook banner ----------------------------------------------------------------

def banner(text: str, *, width: int = 1080, footage_top: int = 570, **kwargs):
    return mt.plan_hook_banner(text, canvas_width=width, footage_top=footage_top, base_size=60, min_size=32, line_height=1.0, measure=measure, **kwargs)


def test_banner_blank_text_or_no_headroom_draws_nothing() -> None:
    assert banner("") is None and banner("   \n ") is None
    assert banner("Hook", footage_top=0) is None


def test_banner_ends_exactly_at_the_footage_and_fits_two_lines() -> None:
    plan_ = banner("A short hook that fits on one or two lines")
    assert plan_ is not None
    assert plan_.bottom == 570 and 0 <= plan_.top < plan_.bottom
    assert len(plan_.lines) <= 2 and plan_.font_size == 60
    assert plan_.top + (plan_.bottom - plan_.top) / 2 == pytest.approx(plan_.centre_y)


def test_banner_allows_a_measured_third_line_for_a_long_hook_and_keeps_all_words() -> None:
    long_hook = "word " * 19 + "word"
    plan_ = banner(long_hook)
    assert plan_ is not None
    assert " ".join(plan_.lines).split() == long_hook.split()
    assert len(plan_.lines) <= 3
    assert plan_.font_size >= 32
    plan_hundred = banner(("abcdefghi " * 10).strip()[:100])
    assert plan_hundred is not None and "".join(plan_hundred.lines).replace(" ", "") == ("abcdefghi " * 10).strip()[:100].replace(" ", "")


def test_banner_never_truncates_when_headroom_is_tiny() -> None:
    plan_ = banner("Keep every single word of this long hook text visible", footage_top=60)
    assert plan_ is not None
    assert " ".join(plan_.lines) == "Keep every single word of this long hook text visible"
    assert plan_.bottom - plan_.top <= 60


def test_strict_banner_reports_when_the_reserved_space_is_too_small() -> None:
    assert banner("Hook text", footage_top=570, available_height=30, strict=True) is None
    fits = banner("Hook text", footage_top=570, available_height=200, strict=True)
    assert fits is not None and fits.top >= 570 - 200


def test_a_single_overwide_word_gets_its_own_line() -> None:
    plan_ = banner("Hi " + "W" * 80, width=400)
    assert plan_ is not None and "W" * 80 in plan_.lines
    assert all(isinstance(line, str) and line for line in plan_.lines)


# --- written ASS ------------------------------------------------------------------

def _ass(tmp_path: Path, **kwargs) -> str:
    path = tmp_path / "out.ass"
    write_music_ass(path, words_from(SONG), offset=0, duration=12, width=1080, height=1920, **kwargs)
    return path.read_text(encoding="utf-8")


def test_legacy_and_omitted_animation_write_byte_identical_scripts(tmp_path: Path) -> None:
    for theme in ("clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif"):
        omitted = _ass(tmp_path, subtitle_theme=theme, top_text="Title")
        legacy = _ass(tmp_path, subtitle_theme=theme, top_text="Title", lyric_animation="legacy", hook_text_format="plain")
        assert omitted == legacy
        assert r"\fad(" not in omitted


@pytest.mark.parametrize("theme", ["clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif", "condensed_black", "condensed_white", "handwritten_stack"])
@pytest.mark.parametrize("animation", ["slow_fade", "line_crossfade", "word_build"])
def test_every_theme_and_animation_combination_writes_opacity_events(tmp_path: Path, animation: str, theme: str) -> None:
    text = _ass(tmp_path, subtitle_theme=theme, lyric_animation=animation)
    events = [line for line in text.splitlines() if line.startswith("Dialogue:") and ",Caption," in line]
    assert events
    assert all(r"\fad(" in line or r"\t(" in line for line in events)
    assert all(r"\pos(" in line for line in events)


@pytest.mark.parametrize("theme", ["condensed_black", "condensed_white", "handwritten_stack"])
def test_new_themes_use_new_families_and_work_with_original_animation(tmp_path: Path, theme: str) -> None:
    text = _ass(tmp_path, subtitle_theme=theme)
    family = "Gaegu" if theme == "handwritten_stack" else "Oswald"
    assert f"Style: Caption,{family}," in text
    assert [line for line in text.splitlines() if ",Caption," in line and line.startswith("Dialogue")]
    assert r"\fad(" not in text


def test_new_animation_does_not_change_cues_or_sidecars() -> None:
    from engine.media import music_caption_cues

    words = words_from(SONG)
    assert music_caption_cues(words, 0, 12) == music_caption_cues(words, 0, 12)
    assert [c["start"] for c in music_caption_cues(words, 0, 12)] == [w["start"] for w in words]


def test_banner_script_has_rect_under_text_and_plain_default_has_none(tmp_path: Path) -> None:
    banner_ass = _ass(tmp_path, subtitle_theme="clean", top_text="Hook {line}", hook_text_format="white_banner", source_dimensions=(1920, 1080))
    rect = [l for l in banner_ass.splitlines() if l.startswith("Dialogue: 15,") and "HookScrim" in l]
    text = [l for l in banner_ass.splitlines() if l.startswith("Dialogue: 20,") and "MusicTop" in l]
    assert len(rect) == 1 and len(text) == 1
    assert r"\1c&HFFFFFF&" in rect[0] and r"\1c&H000000&" in text[0] and r"Hook \{line\}" in text[0]
    plain = _ass(tmp_path, subtitle_theme="clean", top_text="Hook", source_dimensions=(1920, 1080))
    assert "HookScrim," not in "\n".join(l for l in plain.splitlines() if l.startswith("Dialogue"))
    for blank in (None, "", "   "):
        none = _ass(tmp_path, subtitle_theme="clean", top_text=blank, hook_text_format="white_banner")
        assert "Dialogue: 15," not in none


def test_banner_geometry_comes_from_the_fitted_footage_rectangle(tmp_path: Path) -> None:
    import re
    from engine.media import _music_layout_geometry

    for source in ((1920, 1080), (1080, 1920), (1080, 1080)):
        for canvas in ((1080, 1920), (1080, 1080), (1080, 1350), (1920, 1080)):
            _, _, footage_top = _music_layout_geometry(*canvas, source)
            path = tmp_path / "geo.ass"
            write_music_ass(path, [], offset=0, duration=3, width=canvas[0], height=canvas[1], top_text="Hook text for geometry", subtitle_theme="clean", hook_text_format="white_banner", source_dimensions=source)
            rects = [l for l in path.read_text().splitlines() if "HookScrim," in l and l.startswith("Dialogue: 15,")]
            if not footage_top:
                assert not rects
                continue
            assert rects, (source, canvas)
            match = re.search(r"m 0 (\d+) l (\d+) (\d+) (\d+) (\d+) 0 (\d+)", rects[0])
            assert match
            top, right, top_again, right_again, bottom, bottom_left = (int(g) for g in match.groups())
            assert right == right_again == canvas[0] and top == top_again
            assert bottom == bottom_left == footage_top and 0 <= top < bottom


def test_banner_yields_to_the_subscribe_animation_only_when_there_is_no_room(tmp_path: Path) -> None:
    from engine.media import _music_layout_geometry, _subscribe_reserve_top

    reserve = _subscribe_reserve_top(1080, 1920, "short")
    # 16:9 footage leaves enough clear space under the animation's visible pixels...
    _, _, wide_top = _music_layout_geometry(1080, 1920, (1920, 1080))
    path = tmp_path / "sub.ass"
    write_music_ass(path, [], offset=0, duration=30, width=1080, height=1920, top_text="Short hook", subtitle_theme="clean", hook_text_format="white_banner", source_dimensions=(1920, 1080), banner_reserve_top=reserve, hook_end_time=25)
    rect = next(l for l in path.read_text().splitlines() if l.startswith("Dialogue: 15,"))
    assert wide_top - reserve > 0
    assert ",0:00:30.00," in rect  # whole clip
    # ...while 9:16 footage does not, so the banner ends when the animation starts.
    _, _, tall_top = _music_layout_geometry(1080, 1920, (1080, 1920))
    write_music_ass(path, [], offset=0, duration=30, width=1080, height=1920, top_text="Short hook", subtitle_theme="clean", hook_text_format="white_banner", source_dimensions=(1080, 1920), banner_reserve_top=reserve, hook_end_time=25)
    rect = next(l for l in path.read_text().splitlines() if l.startswith("Dialogue: 15,"))
    assert tall_top - reserve < 60 and ",0:00:25.00," in rect


def test_speech_write_ass_ignores_music_only_arguments(tmp_path: Path) -> None:
    from engine.media import write_ass

    words = words_from(SONG)
    base = tmp_path / "base.ass"
    extra = tmp_path / "extra.ass"
    write_ass(base, words, offset=0, duration=12, visuals=[], width=1080, height=1920, style="educational", content_format="short")
    write_ass(extra, words, offset=0, duration=12, visuals=[], width=1080, height=1920, style="educational", content_format="short",
              music_lyric_animation="word_build", music_hook_text_format="white_banner", music_source_dimensions=(1920, 1080))
    assert base.read_text() == extra.read_text()


def test_unknown_options_are_rejected_by_the_music_writer(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        write_music_ass(tmp_path / "a.ass", [], offset=0, duration=1, width=1080, height=1920, lyric_animation="spin")
    with pytest.raises(ValueError):
        write_music_ass(tmp_path / "a.ass", [], offset=0, duration=1, width=1080, height=1920, hook_text_format="neon")
    with pytest.raises(ValueError):
        write_music_ass(tmp_path / "a.ass", [], offset=0, duration=1, width=1080, height=1920, subtitle_theme="neon")
