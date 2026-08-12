from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_cpu_environment.py"
spec = spec_from_file_location("verify_cpu_environment", SCRIPT)
verify = module_from_spec(spec)
spec.loader.exec_module(verify)


def test_cpu_package_audit_rejects_gpu_distributions():
    found = verify.prohibited_distributions([
        "fastapi",
        "nvidia-cudnn-cu13",
        "cuda-toolkit",
        "onnxruntime-gpu",
        "triton",
    ])
    assert found == [
        "cuda-toolkit",
        "nvidia-cudnn-cu13",
        "onnxruntime-gpu",
        "triton",
    ]


def test_cpu_package_audit_accepts_cpu_stack():
    assert verify.prohibited_distributions([
        "torch",
        "torchvision",
        "onnxruntime",
        "ctranslate2",
        "faster-whisper",
    ]) == []


def test_cpu_lock_has_no_gpu_packages():
    lock = (SCRIPT.parents[1] / "requirements-cpu.lock").read_text(encoding="utf-8").lower()
    assert verify.prohibited_distributions(
        line.split("==", 1)[0]
        for line in lock.splitlines()
        if "==" in line and not line.lstrip().startswith("#")
    ) == []


def test_default_compose_has_no_gpu_runtime_or_device_reservation():
    compose_lines = (SCRIPT.parents[1] / "docker-compose.yml").read_text(
        encoding="utf-8"
    ).lower().splitlines()
    compose = "\n".join(line for line in compose_lines if not line.lstrip().startswith("#"))
    assert "runtime: nvidia" not in compose
    assert "driver: nvidia" not in compose
    assert "capabilities: [gpu]" not in compose
    assert "nvidia_visible_devices" not in compose


def test_default_dockerfile_is_cpu_only():
    dockerfile = (SCRIPT.parents[1] / "Dockerfile").read_text(encoding="utf-8").lower()
    assert dockerfile.startswith("# s6_cut — default cpu-only")
    assert "from nvidia/" not in dockerfile
    assert "requirements-cpu.lock" in dockerfile
    assert "requirements-gpu.lock" not in dockerfile
    assert "verify_cpu_environment.py --installed --filesystem" in dockerfile
