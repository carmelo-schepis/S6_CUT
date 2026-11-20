#!/usr/bin/env python3
"""Patch generated cursor_platform_workflow HCL for PR + test delivery policy."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

POLICY_HEADER = "## Delivery policy (required)"


def load_policy(policy_path: Path) -> str:
    return policy_path.read_text(encoding="utf-8").strip()


def strip_open_git_pr(block: str) -> str:
    """Remove open_git_pr from disabled_default_tools (or drop the attribute)."""

    inline = re.search(
        r'(?m)^\s*disabled_default_tools\s*=\s*\[(?P<items>[^\]]*)\]\s*$',
        block,
    )
    if inline:
        raw_items = [p.strip().strip('"') for p in inline.group("items").split(",") if p.strip()]
        kept = [f'"{x}"' for x in raw_items if x != "open_git_pr"]
        if kept:
            block = block[: inline.start()] + f"  disabled_default_tools = [{', '.join(kept)}]\n" + block[inline.end() :]
        else:
            block = block[: inline.start()] + block[inline.end() :]
        return block

    def repl(match: re.Match[str]) -> str:
        inner = match.group(1)
        items = [
            ln.strip().rstrip(",")
            for ln in inner.splitlines()
            if ln.strip() and "open_git_pr" not in ln
        ]
        if not items:
            return ""
        joined = ",\n".join(f"    {it}" for it in items)
        return f"  disabled_default_tools = [\n{joined},\n  ]\n"

    return re.sub(
        r"(?ms)^\s*disabled_default_tools\s*=\s*\[(.*?)^\s*\]\s*\n",
        repl,
        block,
        count=1,
    )


def patch_skip_install(block: str) -> str:
    if re.search(r"(?m)^\s*skip_install\s*=", block):
        return re.sub(
            r"(?m)^\s*skip_install\s*=\s*true\s*$",
            "  skip_install = false",
            block,
        )
    return block


def ensure_git_pr_action(block: str) -> str:
    if re.search(r"(?m)\bgit_pr\s*=", block):
        return block

    git_pr_snippet = "  action = [\n    {\n      git_pr = {}\n    },\n  ]\n"

    if re.search(r"(?m)^\s*action\s*=", block):
        return re.sub(
            r"(?m)^(\s*action\s*=\s*\[\s*)$",
            r"\1\n    {\n      git_pr = {}\n    },",
            block,
            count=1,
        )

    # No action block: add after prompt (or after skip_install / disabled_default_tools)
    return re.sub(r"\n(\s*trigger\s*=)", "\n" + git_pr_snippet + r"\1", block, count=1)


def append_policy_to_prompt(block: str, policy: str) -> str:
    if POLICY_HEADER in block:
        return block

    heredoc = re.search(
        r'(?ms)^\s*prompt\s*=\s*<<-?(?P<tag>[A-Za-z0-9_]+)\s*\n(?P<body>.*?)^\s*(?P=tag)\s*\n',
        block,
    )
    if heredoc:
        body = heredoc.group("body").rstrip("\n")
        tag = heredoc.group("tag")
        new_body = f"{body}\n\n{policy}\n"
        replacement = f"  prompt = <<-{tag}\n{new_body}{tag}\n"
        return block[: heredoc.start()] + replacement + block[heredoc.end() :]

    quoted = re.search(r'(?m)^\s*prompt\s*=\s*"(?P<body>(?:\\.|[^"\\])*)"\s*$', block)
    if quoted:
        body = quoted.group("body").replace("\\n", "\n").replace('\\"', '"')
        new_body = f"{body.rstrip()}\n\n{policy}"
        escaped = new_body.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        return block[: quoted.start()] + f'  prompt = "{escaped}"' + block[quoted.end() :]

    raise ValueError("Could not locate prompt attribute in resource block")


def extract_resources(content: str) -> tuple[str, list[str]]:
    pattern = re.compile(
        r'resource\s+"cursor_platform_workflow"\s+"[^"]+"\s*\{',
        re.MULTILINE,
    )
    matches = list(pattern.finditer(content))
    if not matches:
        return content, []

    prefix = content[: matches[0].start()]
    blocks: list[str] = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        blocks.append(content[start:end])
    return prefix, blocks


def balance_resource_block(block: str) -> str:
    depth = 0
    for idx, ch in enumerate(block):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return block[: idx + 1] + "\n"
    return block


def patch_resource_block(block: str, policy: str) -> str:
    block = balance_resource_block(block)
    block = strip_open_git_pr(block)
    block = patch_skip_install(block)
    block = ensure_git_pr_action(block)
    block = append_policy_to_prompt(block, policy)
    return block


def patch_file(src: Path, dst: Path, policy_path: Path) -> None:
    policy = load_policy(policy_path)
    content = src.read_text(encoding="utf-8")
    prefix, blocks = extract_resources(content)
    if not blocks:
        raise ValueError(f"No cursor_platform_workflow resources in {src}")

    patched: list[str] = []
    for block in blocks:
        try:
            patched.append(patch_resource_block(block, policy))
        except ValueError as exc:
            name = re.search(r'cursor_platform_workflow"\s+"([^"]+)"', block)
            label = name.group(1) if name else "unknown"
            raise ValueError(f"Failed to patch resource {label}: {exc}") from exc

    dst.write_text(prefix + "".join(patched), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Generated Terraform HCL path")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Patched output path")
    parser.add_argument(
        "--policy",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "policy-delivery.md",
        help="Delivery policy markdown snippet",
    )
    args = parser.parse_args()
    patch_file(args.input, args.output, args.policy)
    print(f"Patched workflows written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())