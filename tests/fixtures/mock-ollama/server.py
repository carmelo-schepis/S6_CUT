"""Deterministic Ollama stand-in for isolated S6_cut acceptance stacks.

Serves GET /api/tags and POST /api/chat (native Ollama API). Replies are valid
for whichever structured schema the engine sends, built from the request's own
indexes/clip IDs, so no real model is needed. Every chat call is appended to
MOCK_OLLAMA_LOG as one JSON line so specs can prove which provider was used.
Never used in production; only mounted into disposable acceptance stacks.
"""

from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("MOCK_OLLAMA_LOG", "/tmp/mock-ollama-calls.jsonl")
MODELS = [{"name": "llama3.2:latest"}, {"name": "qwen2.5:0.5b:latest"}]


def _reply(body: dict) -> dict:
    fmt = body.get("format") if isinstance(body.get("format"), dict) else {}
    required = fmt.get("required", []) if isinstance(fmt.get("required"), list) else []
    user = next((m.get("content", "") for m in reversed(body.get("messages", [])) if m.get("role") == "user"), "")
    if required == ["ok"]:
        return {"ok": True}
    if "indexes" in required:
        wanted = re.search(r"Choose up to (\d+)", user)
        indexes = list(dict.fromkeys(int(i) for i in re.findall(r'"index": ?(\d+)', user)))
        return {"indexes": indexes[: int(wanted.group(1)) if wanted else 1] or [0]}
    if "hooks" in required:
        indexes = list(dict.fromkeys(int(i) for i in re.findall(r'"index": ?(\d+)', user)))
        return {"hooks": [{"index": i, "text": f"Watch cut {i} unfold"} for i in indexes]}
    if "clips" in required:
        ids = list(dict.fromkeys(re.findall(r'"clip_id": ?"([^"]+)"', user)))
        # Titles must be unique across batches and the Library, so derive them from the clip ID.
        return {"clips": [{"clip_id": cid, "title": f"Ollama highlight {cid[:8]}", "description": "A short grounded summary of the spoken moment."} for cid in ids]}
    if "clip_id" in required:
        cid = (re.findall(r'"clip_id": ?"([^"]+)"', user) or ["unknown"])[0]
        return {"clip_id": cid, "title": f"Ollama highlight {cid[:8]}", "description": "A short grounded summary of the spoken moment."}
    return {}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/tags":
            return self._json(200, {"models": MODELS})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        if self.path != "/api/chat":
            return self._json(404, {"error": "not found"})
        content = _reply(body)
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"required": (body.get("format") or {}).get("required"), "model": body.get("model"), "think": body.get("think"), "num_ctx": (body.get("options") or {}).get("num_ctx")}) + "\n")
        self._json(200, {"model": body.get("model"), "message": {"role": "assistant", "content": json.dumps(content)}, "done": True, "done_reason": "stop", "prompt_eval_count": 64, "eval_count": 48})

    def log_message(self, *_: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 11434), Handler).serve_forever()
