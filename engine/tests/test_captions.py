from __future__ import annotations

from engine.captions import caption_box, contrast_ratio, normalize_and_validate, qa_cues


def _cue(**values):
    return {"id": "cue-1", "start": 0.0, "end": 1.0, "text": "Reviewed phrase", **values}


def test_caption_qa_accepts_clean_cue() -> None:
    _, issues = normalize_and_validate([_cue()], 2)
    assert not [issue for issue in issues if issue["severity"] == "error"]


def test_caption_qa_rejects_timing_overlap_and_empty_text() -> None:
    _, issues = normalize_and_validate([_cue(text="  ", start=-1, end=-2), _cue(id="cue-2", start=.1, end=1)], 2)
    assert {issue["code"] for issue in issues if issue["severity"] == "error"} >= {"empty_text", "invalid_start", "invalid_end", "overlap"}


def test_caption_boxes_use_canonical_canvases() -> None:
    assert caption_box("9:16", 1, 10) is not None
    assert caption_box("4:5", 1, 10) is not None
    assert caption_box("1:1", 1, 10) is not None
    assert caption_box("16:9", 1, 10) is not None
    assert caption_box("bad", 1, 10) is None


def test_caption_contrast_is_deterministic() -> None:
    assert contrast_ratio("#ffffff", "#000000") == 21
    assert contrast_ratio("#000000", "#ffffff") == 21
    assert contrast_ratio("#ffffff", "bad") is None
    issues = qa_cues([_cue()], 2, foreground="#777777", background="#777777")
    assert any(issue["code"] == "insufficient_contrast" for issue in issues)


def test_caption_warning_boundaries() -> None:
    issues = qa_cues([_cue(text="x" * 43)], 2)
    assert any(issue["code"] == "line_too_long" for issue in issues)
    issues = qa_cues([_cue(end=.19)], 2)
    assert any(issue["code"] == "too_short" for issue in issues)
