"""Deterministic OpenRouter stand-in for isolated S6_CUT acceptance stacks.

Only reachable when the engine runs with S6_TEST_MODE=1 and
S6_TEST_OPENROUTER_BASE_URL pointing here. It never sees a real key.
Titles are derived from the request's own transcript/source title so specs
can assert grounding, uniqueness and length without a paid provider.
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CALLS: list[dict] = []
MODELS = [
    {"id": "openai/gpt-4.1-mini", "name": "GPT-4.1 mini (mock)", "context_length": 128000,
     "pricing": {"prompt": "0.0000004", "completion": "0.0000016"}, "supported_parameters": ["response_format", "temperature"],
     "architecture": {"output_modalities": ["text"]}},
    {"id": "google/gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash Lite (mock)", "context_length": 1048576,
     "pricing": {"prompt": "0.0000001", "completion": "0.0000004"}, "supported_parameters": ["response_format", "structured_outputs", "temperature"],
     "architecture": {"output_modalities": ["text"]}},
]
STOP = {"the", "a", "an", "and", "but", "so", "um", "uh", "i", "we", "you", "it", "is", "to", "of", "that", "this", "in", "on", "for", "just", "like", "okay", "ok", "yeah", "all", "right"}


def _words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9'$]+", text or "")


def _title(entity: str, transcript: str, used: set[str], n: int) -> str:
    keywords = [word for word in _words(transcript) if word.casefold() not in STOP][:6]
    hook = " ".join(keywords[:5]).title() or f"Moment {n}"
    entity = " ".join(_words(entity)[:4])
    base = f"{entity}: {hook}" if entity else hook
    title = base[:70].rstrip(" :")
    candidate, i = title, 2
    while candidate.casefold() in used:
        candidate = f"{title[:64]} ({i})"
        i += 1
    used.add(candidate.casefold())
    return candidate


def _description(entity: str, transcript: str) -> str:
    sentence = " ".join(_words(transcript)[:28])
    lead = f"{entity}: " if entity else ""
    return (f"{lead}{sentence}.").strip()[:280] + "\n#Shorts #Food"


def _content_for(body: dict) -> dict:
    messages = body.get("messages") or []
    text = "\n".join(str(message.get("content", "")) for message in messages)
    if '{"ok":true}' in text:
        return {"ok": True}
    schema = (((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {})
    props = schema.get("properties") or {}
    if "indexes" in props:
        top = int((props["indexes"].get("maxItems")) or 1)
        return {"indexes": list(range(top))}
    if "clips" in props or "clip_id" in props:
        user = json.loads(messages[-1]["content"])
        avoid = {title.casefold() for title in user.get("avoid_titles", [])}
        items = user.get("clips") or []
        out = []
        for n, item in enumerate(items, 1):
            entity = item.get("source_title") or user.get("source_title") or ""
            out.append({"clip_id": item["clip_id"], "title": _title(entity, item.get("transcript", ""), avoid, n), "description": _description(entity, item.get("transcript", ""))})
        return out[0] if "clip_id" in props else {"clips": out}
    if "hooks" in props:
        return {"hooks": []}
    return {}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: object) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/__calls"):
            return self._send(200, CALLS)
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True})
        if self.path.startswith("/models"):
            return self._send(200, {"data": MODELS})
        return self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.startswith("/chat/completions"):
            return self._send(404, {"error": "not found"})
        content = _content_for(body)
        CALLS.append({"model": body.get("model"), "max_tokens": body.get("max_tokens"), "schema_keys": sorted(((((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}).get("properties") or {}).keys()), "response": content})
        usage = {"prompt_tokens": 600, "completion_tokens": 40 + 120 * len(content.get("clips", [])) if isinstance(content, dict) else 40, "cost": 0.00009}
        return self._send(200, {"id": "mock", "choices": [{"message": {"role": "assistant", "content": json.dumps(content)}}], "usage": usage})

    def log_message(self, fmt: str, *args) -> None:
        print(f"mock-openrouter {self.command} {self.path}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 4010), Handler).serve_forever()
