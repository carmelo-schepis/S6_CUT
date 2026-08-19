#!/usr/bin/env bash
#
# S6_cut installer for Linux and macOS
# ====================================
# One-command install/update via Docker Compose.
#
# PRIVATE REPO (authenticated — works now):
#   gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/install.sh | bash
#
# PUBLIC REPO (anonymous — works after repository is made public):
#   curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/master/install.sh | bash
#
# Installs into ~/s6_cut by default. Safe to run repeatedly: an existing
# installation is updated and rebuilt in place, and your .env, projects,
# Library, media, outputs, models, and persistent Docker state are never
# deleted or overwritten.
#
# Environment overrides (set these before running the command):
#   S6_INSTALL_DIR    installation directory      (default: ~/s6_cut)
#   S6_REPO_URL       repository to clone/update  (default: https://github.com/carmelo-schepis/S6_CUT.git)
#   S6_BRANCH         branch to track             (default: master)
#   S6_START_TIMEOUT  seconds to wait for startup (default: 300)
#   S6_FORCE_RECREATE force recreate containers   (default: false)

set -euo pipefail

INSTALL_DIR="${S6_INSTALL_DIR:-$HOME/s6_cut}"
REPO_URL="${S6_REPO_URL:-https://github.com/carmelo-schepis/S6_CUT.git}"
BRANCH="${S6_BRANCH:-master}"
START_TIMEOUT="${S6_START_TIMEOUT:-300}"
FORCE_RECREATE="${S6_FORCE_RECREATE:-false}"
COMPOSE_FILE="compose.yaml"
CURRENT_STEP="starting"

# --- formatting ---------------------------------------------------------------

info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  \033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

die() {
  fail "$*"
  exit 1
}

report_failure() {
  local code=$?
  fail "S6_cut installation failed (${CURRENT_STEP})."
  if [[ -f "$INSTALL_DIR/$COMPOSE_FILE" ]]; then
    echo
    info "Diagnostics — service status"
    (cd "$INSTALL_DIR" && docker compose ps) 2>/dev/null || true
    echo
    info "Diagnostics — recent container logs"
    (cd "$INSTALL_DIR" && docker compose logs --tail=60) 2>/dev/null || true
  fi
  exit "$code"
}
trap report_failure ERR

# --- checks -------------------------------------------------------------------

check_os() {
  CURRENT_STEP="checking the operating system"
  case "$(uname -s)" in
    Linux|Darwin) : ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows shells are not supported by this installer. On Windows, use Install-S6_CUT.ps1 from the repository." ;;
    *)
      warn "Unrecognised operating system '$(uname -s)'. This installer targets Linux and macOS; continuing anyway." ;;
  esac
}

check_prerequisites() {
  CURRENT_STEP="checking prerequisites"
  command -v git >/dev/null 2>&1 \
    || die "Git is not installed. Install it first (https://git-scm.com/downloads), then re-run the install command."
  ok "Git found"
  command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed. S6_cut runs in Docker: install Docker Engine on Linux (https://docs.docker.com/engine/install/) or Docker Desktop on macOS (https://docs.docker.com/desktop/), then re-run the install command."
  ok "Docker found"
  docker info >/dev/null 2>&1 \
    || die "Docker is installed but its engine is not running or not reachable. Start Docker (for example Docker Desktop), wait until it is ready, then re-run the install command."
  ok "Docker engine is running"
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is required but the 'docker compose' command is missing. Install Docker Compose v2 (https://docs.docker.com/compose/install/), then re-run the install command."
  fi
  ok "Docker Compose found"
  command -v curl >/dev/null 2>&1 \
    || die "curl is not installed. Install it (for example 'sudo apt install curl' on Debian/Ubuntu or 'brew install curl' on macOS), then re-run the install command."
  ok "curl found"
}

# --- repository ----------------------------------------------------------------

prepare_repository() {
  CURRENT_STEP="downloading S6_cut"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    ok "S6_cut repository found at $INSTALL_DIR"
    if (cd "$INSTALL_DIR" && git fetch --quiet origin); then
      if ! (cd "$INSTALL_DIR" && git pull --quiet --ff-only origin "$BRANCH" 2>/dev/null); then
        warn "Could not fast-forward to the latest ${BRANCH} (local changes?). Keeping the current source."
      fi
    else
      warn "Could not reach the repository remote. Keeping the current source."
    fi
    ok "Repository updated"
  elif [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/$COMPOSE_FILE" ]]; then
    warn "Found an existing S6_cut installation at $INSTALL_DIR (not a git checkout). Reusing it in place."
    ok "Repository ready"
  elif [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    die "$INSTALL_DIR already exists and is not an S6_cut installation. Move it aside, or set S6_INSTALL_DIR to a different location."
  else
    step "Downloading S6_cut into $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    ok "Repository downloaded"
  fi
  cd "$INSTALL_DIR"
}

# --- configuration --------------------------------------------------------------

prepare_environment() {
  CURRENT_STEP="preparing configuration"
  if [[ -f .env ]]; then
    ok "Configuration ready (.env preserved)"
  elif [[ -f .env.example ]]; then
    cp .env.example .env
    ok "Configuration ready (created .env from the template)"
  else
    warn ".env.example is missing; using the built-in defaults."
    ok "Configuration ready (defaults)"
  fi
}

# --- containers -----------------------------------------------------------------

start_containers() {
  CURRENT_STEP="building and starting the containers"
  step "Building S6_cut (the first build can take several minutes)..."
  step "Starting containers..."
  if [[ "$FORCE_RECREATE" == "true" ]]; then
    docker compose up -d --build --force-recreate
  else
    docker compose up -d --build
  fi
  ok "Containers started"
}

read_env() {
  local name="$1" default="$2" value=""
  if [[ -f .env ]]; then
    value="$(grep -E "^${name}=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  fi
  printf '%s' "${value:-$default}"
}

wait_for_ready() {
  CURRENT_STEP="waiting for S6_cut to become ready"
  local web_port url deadline
  web_port="$(read_env S6_PORT 8080)"
  url="http://127.0.0.1:${web_port}/api/health"
  step "Waiting for S6_cut to become ready (timeout ${START_TIMEOUT}s)..."
  deadline=$(( $(date +%s) + START_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; then
      ok "S6_cut is ready"
      return 0
    fi
    sleep 3
  done
  fail "S6_cut did not become ready within ${START_TIMEOUT} seconds."
  echo
  info "Diagnostics — service status"
  docker compose ps || true
  echo
  info "Diagnostics — recent container logs"
  docker compose logs --tail=60 || true
  die "S6_cut failed to start. Review the diagnostics above, fix the cause, and re-run the install command."
}

# --- summary --------------------------------------------------------------------

report_status() {
  CURRENT_STEP="checking the service status"
  echo
  info "Services"
  docker compose ps
}

print_summary() {
  local web_port engine_port
  web_port="$(read_env S6_PORT 8080)"
  engine_port="$(read_env S6_ENGINE_PORT 8001)"
  echo
  ok "S6_cut is running"
  echo
  printf '  Frontend: http://localhost:%s\n' "$web_port"
  printf '  Backend:  http://localhost:%s\n' "$engine_port"
  echo
  info "Next steps"
  echo "  • Open the Frontend URL in your browser to start creating projects."
  echo "  • The Backend engine (and its API docs) listens on localhost only."
  echo "  • Install directory: $INSTALL_DIR  (your data lives under ${INSTALL_DIR}/data)"
  echo "  • Update S6_cut later: re-run the same install command."
  echo "  • Uninstall (keeps your data): run uninstall.sh — see the README."
}

# --- run ------------------------------------------------------------------------

main() {
  info "S6_cut Installer"
  check_os
  check_prerequisites
  prepare_repository
  prepare_environment
  start_containers
  wait_for_ready
  report_status
  print_summary
}

main "$@"