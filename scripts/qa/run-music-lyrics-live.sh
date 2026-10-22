#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${S6_MUSIC_VIDEO_URL:?Set an authorized YouTube visual source URL}"
: "${S6_MUSIC_SONG_URL:?Set an authorized YouTube song URL}"
: "${S6_PRIVATE_LYRIC_REFERENCE:?Set a private word-timed JSON reference outside Git}"
reference="$(realpath "$S6_PRIVATE_LYRIC_REFERENCE")"
case "$reference" in "$repo_root"/*) echo "The lyric reference must be outside the Git checkout." >&2; exit 2;; esac

run_id="$(date -u +%Y%m%dt%H%M%Sz)_$RANDOM"
artifact="${S6_MUSIC_LYRIC_ARTIFACTS:-/tmp/s6-music-lyrics-$run_id}"
data_dir="$artifact/engine-data"
mkdir -p "$data_dir" "$artifact/logs"
chmod 0777 "$data_dir"

read -r web_port engine_port < <(python3 - <<'PY'
import socket
sockets = []
for _ in range(2):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets:
    sock.close()
PY
)
project="s6lyric-$run_id"
override="$artifact/compose.override.yaml"
cat > "$override" <<YAML
services:
  engine:
    volumes:
      - type: bind
        source: /home/linuxpc/Git_projects/S6_CUT/data/models
        target: /app/data/models
        read_only: true
    environment:
      S6_MUSIC_WHISPER_MODEL: small
      HF_HOME: /tmp/s6-music-hf
      HF_XET_CACHE: /tmp/s6-music-hf/xet
YAML
export S6_PORT="127.0.0.1:$web_port"
export S6_ENGINE_PORT="$engine_port"
export S6_DATA_PATH="$data_dir"
export S6_BUILD_REVISION="music-lyric-repair-$(git -C "$repo_root" rev-parse --short HEAD)"
export S6_ACCEPTANCE_URL="http://127.0.0.1:$web_port"
export S6_MUSIC_LYRIC_ARTIFACTS="$artifact"
compose=(docker compose --project-name "$project" --file "$repo_root/compose.yaml" --file "$override")
passed=0
cleanup() {
  # Export the exact private transcript used by this job before teardown.
  python3 - "$artifact" "$data_dir" <<'PYTHON' || true
import json
import sqlite3
import sys
from pathlib import Path

artifact, data_dir = map(Path, sys.argv[1:])
report_path = artifact / "verification.json"
database_path = data_dir / "s6-cut.sqlite3"
if report_path.is_file() and database_path.is_file():
    report = json.loads(report_path.read_text(encoding="utf-8"))
    connection = sqlite3.connect(database_path)
    try:
        row = connection.execute("SELECT private_payload FROM jobs WHERE id=?", (report["jobId"],)).fetchone()
        if row:
            private = json.loads(row[0])
            key = private.get("transcript_cache_key")
            cached = connection.execute("SELECT payload FROM analysis_cache WHERE cache_key=?", (key,)).fetchone() if key else None
            if cached:
                transcript = json.loads(cached[0])
                (artifact / "raw-transcript.json").write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                (artifact / "transcript-diagnostics.json").write_text(json.dumps(transcript.get("diagnostics", {}), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    finally:
        connection.close()
PYTHON
  "${compose[@]}" logs > "$artifact/logs/compose.log" 2>&1 || true
  "${compose[@]}" down --remove-orphans > "$artifact/logs/compose-down.log" 2>&1 || true
  # Keep the complete private reproduction for both successful and failed
  # runs: source media, PCM, raw transcript state, generated output, and logs
  # are needed to inspect recognition and renderer behavior later.
  printf '%s\n' "$data_dir" > "$artifact/retained-data-path.txt"
  printf '%s\n' "$artifact" > /tmp/s6-music-lyrics-last-artifact.txt
}
trap cleanup EXIT INT TERM

"${compose[@]}" up --build -d
for attempt in $(seq 1 120); do
  if curl --fail --silent "$S6_ACCEPTANCE_URL/healthz" >/dev/null &&
     curl --fail --silent "$S6_ACCEPTANCE_URL/api/health" > "$artifact/logs/health.json"; then
    break
  fi
  if [ "$attempt" -eq 120 ]; then
    "${compose[@]}" ps > "$artifact/logs/compose-ps.txt"
    exit 1
  fi
  sleep 5
done

cd "$repo_root"
npx playwright test --config playwright.config.ts --project="Desktop Chromium" \
  --output="$artifact/playwright-results" tests/acceptance/music-lyrics-live.spec.ts
passed=1
