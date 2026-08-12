import json
from types import SimpleNamespace

from s6_cut.pipeline import orchestrator


class FakeState:
    def __init__(self):
        self.total = None

    def artifact(self, _name):
        return None

    def completed(self, _stage):
        return False

    def start(self, *_args, **_kwargs):
        pass

    def set_clip_total(self, total):
        self.total = total

    def complete_stage(self, *_args, **_kwargs):
        pass


class OfflineLegacy:
    @staticmethod
    def get_viral_clips(*_args, **_kwargs):
        return None

    @staticmethod
    def build_texttiling_fallback(_transcript, _title):
        return {
            "shorts": [{
                "start": 0.0,
                "end": 5.0,
                "video_title_for_youtube_short": "Offline clip",
            }]
        }


def test_missing_gemini_uses_texttiling_and_persists_structured_warning(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("S6CUT_SILENCE_SNAP", "0")
    args = SimpleNamespace(
        skip_analysis=False,
        monitor=False,
        instructions=None,
        aspect="9:16",
        reframe_mode="auto",
    )
    transcript = {"segments": []}
    state = FakeState()

    result, metadata_path = orchestrator._load_or_analyze(
        args,
        str(tmp_path / "source.mp4"),
        "Source",
        str(tmp_path),
        5.0,
        transcript,
        state,
        OfflineLegacy(),
    )

    warning = result["warnings"][0]
    assert warning == {
        "code": "provider_not_configured",
        "severity": "warning",
        "fatal": False,
        "phase": "clip_selection",
        "provider": "gemini",
        "message": "Gemini is not configured; offline clip selection was used.",
        "fallback": "texttiling",
    }
    assert result["provider_decisions"]["clip_selection"] == {
        "requested": "gemini",
        "selected": "texttiling",
        "fallback": True,
    }
    assert state.total == 1
    with open(metadata_path, encoding="utf-8") as handle:
        assert json.load(handle)["warnings"] == [warning]
