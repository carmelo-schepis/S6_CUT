"""Lightweight runtime capability detection and device selection.

CPU is always the default. Accelerators are considered only when the operator
explicitly opts in with ``S6CUT_DEVICE=cuda`` (or ``auto``). Detection never
loads an ML model or downloads weights, so importing this module is safe for
API startup, health checks, tests, and CPU-only installations.
"""
import importlib
import importlib.util
import os
from dataclasses import asdict, dataclass

import psutil


@dataclass(frozen=True)
class RuntimeCapabilities:
    requested_device: str
    selected_device: str
    accelerator: str | None
    accelerator_available: bool
    torch_available: bool
    gpu_name: str | None
    gpu_vram_gb: float
    total_ram_gb: float
    performance_profile: str
    fallback_reason: str | None

    def as_dict(self):
        return asdict(self)


def _requested_device():
    value = (os.getenv("S6CUT_DEVICE") or "cpu").strip().lower()
    return value if value in {"cpu", "cuda", "auto"} else "cpu"


def _load_torch():
    try:
        return importlib.import_module("torch")
    except (ImportError, OSError):
        return None


def detect_runtime_capabilities():
    requested = _requested_device()
    total_ram_gb = round(psutil.virtual_memory().total / (1024**3), 1)
    profile = (os.getenv("S6CUT_PERFORMANCE_PROFILE") or "cpu_balanced").strip()

    # Do not even import Torch for the default CPU path. This keeps diagnostics
    # and API startup working if Torch is intentionally omitted in a minimal
    # deployment, while Ultralytics/Faster-Whisper can import their own runtime
    # dependencies lazily when those stages are actually used.
    if requested == "cpu":
        torch_installed = importlib.util.find_spec("torch") is not None
        return RuntimeCapabilities(
            requested_device=requested,
            selected_device="cpu",
            accelerator=None,
            accelerator_available=False,
            torch_available=torch_installed,
            gpu_name=None,
            gpu_vram_gb=0,
            total_ram_gb=total_ram_gb,
            performance_profile=profile,
            fallback_reason=None,
        )

    torch = _load_torch()
    if torch is None:
        return RuntimeCapabilities(
            requested_device=requested,
            selected_device="cpu",
            accelerator="cuda",
            accelerator_available=False,
            torch_available=False,
            gpu_name=None,
            gpu_vram_gb=0,
            total_ram_gb=total_ram_gb,
            performance_profile=profile,
            fallback_reason="torch_unavailable",
        )

    try:
        cuda_available = bool(torch.cuda.is_available())
    except (AttributeError, OSError, RuntimeError):
        cuda_available = False

    if not cuda_available:
        return RuntimeCapabilities(
            requested_device=requested,
            selected_device="cpu",
            accelerator="cuda",
            accelerator_available=False,
            torch_available=True,
            gpu_name=None,
            gpu_vram_gb=0,
            total_ram_gb=total_ram_gb,
            performance_profile=profile,
            fallback_reason="cuda_unavailable",
        )

    try:
        name = str(torch.cuda.get_device_name(0))
        vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 1)
    except (AttributeError, OSError, RuntimeError):
        name = None
        vram_gb = 0

    return RuntimeCapabilities(
        requested_device=requested,
        selected_device="cuda",
        accelerator="cuda",
        accelerator_available=True,
        torch_available=True,
        gpu_name=name,
        gpu_vram_gb=vram_gb,
        total_ram_gb=total_ram_gb,
        performance_profile=profile,
        fallback_reason=None,
    )


CAPABILITIES = detect_runtime_capabilities()
DEVICE = CAPABILITIES.selected_device
CUDA_AVAILABLE = DEVICE == "cuda"
GPU_VRAM_GB = CAPABILITIES.gpu_vram_gb


def _select_whisper_model():
    override = (os.getenv("WHISPER_MODEL") or "").strip()
    if override:
        return override
    if CUDA_AVAILABLE:
        if GPU_VRAM_GB >= 6:
            return "large-v3"
        if GPU_VRAM_GB >= 3:
            return "medium"
        return "small"
    if CAPABILITIES.total_ram_gb >= 16:
        return "medium"
    if CAPABILITIES.total_ram_gb >= 8:
        return "small"
    return "base"


WHISPER_MODEL = _select_whisper_model()


def runtime_diagnostics():
    """Return a JSON-safe, secret-free snapshot for health/UI diagnostics."""
    return {
        **CAPABILITIES.as_dict(),
        "whisper_model": WHISPER_MODEL,
        "cpu_first": True,
    }
