#!/usr/bin/env bash
# Launch only this run's disposable S6_cut Compose project, then run the live
# UI acceptance suite. Never addresses the default Compose project.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
: "${S6_YOUTUBE_URL:?Set S6_YOUTUBE_URL to an authorized public YouTube URL}"

run_id="$(date -u +%Y%m%dT%H%M%SZ)_$RANDOM"
project="s6accept-${run_id,,}"
artifact="test-artifacts/acceptance-${run_id}"
data_dir="$repo_root/$artifact/disposable-data"
mkdir -p "$data_dir" "$artifact/logs"
# The engine runs as uid 10001 inside the container; grant write access only
# to this newly-created disposable data directory.
chmod 0777 "$data_dir"

# Ask the OS for distinct ephemeral loopback ports and release the sockets
# immediately before Compose binds them. The chosen pair is also asserted by
# Playwright not to be the repository's default 8080/8001.
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
export S6_PORT="127.0.0.1:$web_port" S6_ENGINE_PORT="$engine_port" S6_DATA_PATH="$data_dir"
export S6_ACCEPTANCE_URL="http://127.0.0.1:$web_port"
export S6_ACCEPTANCE_COMPOSE_PROJECT="$project" S6_ACCEPTANCE_ISOLATED=1
export S6_ACCEPTANCE_RUN="$run_id" S6_PLAYWRIGHT_ARTIFACTS="$artifact" S6_ACCEPTANCE_TRACE=1

compose=(docker compose --project-name "$project" --file compose.yaml)
cleanup() {
  # Explicit project scoping: cannot stop or remove containers from another run.
  "${compose[@]}" logs > "$artifact/logs/compose.log" 2>&1 || true
  # The engine writes as uid 10001; relax permissions only inside this
  # disposable bind mount so the host can remove its contents after teardown.
  "${compose[@]}" exec --user 10001 -T engine chmod -R a+rwX /app/data >/dev/null 2>&1 || true
  "${compose[@]}" down --remove-orphans
  chmod -R u+rwX "$data_dir" 2>/dev/null || true
  rm -rf -- "$data_dir"
}
trap cleanup EXIT INT TERM
printf '%s\n' "$project" > "$artifact/compose-project.txt"
printf 'web_port=%s\nengine_port=%s\ndata_dir=%s\n' "$web_port" "$engine_port" "$data_dir" > "$artifact/isolation.txt"
"${compose[@]}" config > "$artifact/logs/compose-config.yaml"
"${compose[@]}" up --build -d

for attempt in $(seq 1 120); do
  if curl --fail --silent "$S6_ACCEPTANCE_URL/healthz" >/dev/null && \
     curl --fail --silent "$S6_ACCEPTANCE_URL/api/health" > "$artifact/logs/health.json"; then
    break
  fi
  if [ "$attempt" -eq 120 ]; then
    "${compose[@]}" ps > "$artifact/logs/compose-ps.txt"
    "${compose[@]}" logs > "$artifact/logs/compose.log" 2>&1 || true
    exit 1
  fi
  sleep 5
done
node -e 'const fs=require("node:fs"); const h=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (h.status !== "ready") process.exit(1)' "$artifact/logs/health.json"

npx playwright test --config playwright.config.ts --project="Desktop Chromium" \
  tests/acceptance/youtube-serious-hype-modes.spec.ts 2>&1 | tee "$artifact/logs/playwright-live.log"
S6_PLAYWRIGHT_ARTIFACTS="$artifact/responsive" npx playwright test --config playwright.config.ts \
  tests/acceptance/youtube-placeholder.spec.ts 2>&1 | tee "$artifact/logs/playwright-responsive.log"
