"""Fail when a purported CPU installation contains GPU-only packages/libraries."""
from __future__ import annotations

import argparse
import importlib.metadata
import os
from pathlib import Path

BANNED_DISTRIBUTION_PREFIXES = (
    "cuda-",
    "nvidia-",
)
BANNED_DISTRIBUTIONS = {
    "onnxruntime-gpu",
    "tensorrt",
    "tensorrt-bindings",
    "torch-tensorrt",
    "triton",
}
BANNED_LIBRARY_MARKERS = (
    "libcuda",
    "libcudnn",
    "libnccl",
    "libnvidia",
    "libtensorrt",
)


def prohibited_distributions(names):
    normalized = {str(name).strip().lower().replace("_", "-") for name in names}
    return sorted(
        name for name in normalized
        if name in BANNED_DISTRIBUTIONS
        or any(name.startswith(prefix) for prefix in BANNED_DISTRIBUTION_PREFIXES)
    )


def installed_distribution_names():
    return [distribution.metadata.get("Name", "") for distribution in importlib.metadata.distributions()]


def prohibited_libraries(roots):
    matches = []
    for root in roots:
        path = Path(root)
        if not path.exists():
            continue
        for directory, dirnames, filenames in os.walk(path):
            dirnames[:] = [name for name in dirnames if name not in {"proc", "sys", "dev"}]
            for filename in filenames:
                lowered = filename.lower()
                if any(marker in lowered for marker in BANNED_LIBRARY_MARKERS):
                    matches.append(str(Path(directory, filename)))
                    if len(matches) >= 50:
                        return matches
    return matches


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--installed", action="store_true")
    parser.add_argument("--filesystem", action="store_true")
    parser.add_argument("--root", action="append", default=[])
    args = parser.parse_args(argv)

    failures = []
    if args.installed:
        packages = prohibited_distributions(installed_distribution_names())
        if packages:
            failures.append("prohibited Python distributions: " + ", ".join(packages))
    if args.filesystem:
        roots = args.root or ["/usr", "/opt"]
        libraries = prohibited_libraries(roots)
        if libraries:
            failures.append("prohibited GPU libraries: " + ", ".join(libraries))

    if failures:
        for failure in failures:
            print(f"CPU environment verification failed: {failure}")
        return 1
    print("CPU environment verification passed: no NVIDIA/CUDA GPU runtime detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
