import importlib
import sys


def _reload_hardware(monkeypatch, device):
    monkeypatch.setenv("S6CUT_DEVICE", device)
    sys.modules.pop("clippyme.pipeline.hardware", None)
    return importlib.import_module("clippyme.pipeline.hardware")


def test_cpu_default_does_not_import_torch(monkeypatch):
    monkeypatch.delenv("S6CUT_DEVICE", raising=False)
    sys.modules.pop("clippyme.pipeline.hardware", None)
    real_import = importlib.import_module

    def guarded_import(name, package=None):
        if name == "torch":
            raise AssertionError("CPU capability detection must not import torch")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", guarded_import)
    hardware = importlib.import_module("clippyme.pipeline.hardware")

    assert hardware.DEVICE == "cpu"
    assert hardware.runtime_diagnostics()["cpu_first"] is True


def test_cuda_opt_in_falls_back_when_torch_is_unavailable(monkeypatch):
    real_import = importlib.import_module

    def missing_torch(name, package=None):
        if name == "torch":
            raise ImportError("not installed")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", missing_torch)
    hardware = _reload_hardware(monkeypatch, "cuda")

    assert hardware.DEVICE == "cpu"
    assert hardware.CAPABILITIES.requested_device == "cuda"
    assert hardware.CAPABILITIES.fallback_reason == "torch_unavailable"


def test_invalid_device_is_safe_cpu(monkeypatch):
    hardware = _reload_hardware(monkeypatch, "quantum")

    assert hardware.DEVICE == "cpu"
    assert hardware.CAPABILITIES.requested_device == "cpu"
