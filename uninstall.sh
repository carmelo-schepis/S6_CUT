#!/usr/bin/env bash
#
# S6_cut uninstaller for Linux and macOS
# ======================================
# Stops and removes the S6_cut Docker containers while preserving your data
# by default. Nothing is deleted unless you explicitly ask for it:
#
#   uninstall.sh                  stop/remove containers (data preserved)
#   uninstall.sh --remove-images  also remove the locally built Docker images
#   uninstall.sh --purge --yes    also delete the installation directory,
#                                 including your data (irreversible)
#
# Environment override:
#   S6_INSTALL_DIR   installation directory (default: ~/s6_cut)

set -euo pipefail

INSTALL_DIR="${S6_INSTALL_DIR:-$HOME/s6_cut}"
COMPOSE_FILE="compose.yaml"
REMOVE_IMAGES=0
PURGE=0
YES=0

info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  \033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

die() {
  fail "$*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

Options:
  --remove-images   Also remove the locally built S6_cut Docker images.
  --purge           Also delete the installation directory, including your
                    data, media, outputs, models, and .env. Irreversible.
  --yes             Confirm a destructive option (required with --purge).
  -h, --help        Show this help.

Without options, uninstall.sh stops and removes the S6_cut containers and
the Compose network. Docker volumes and user files are never deleted.

Environment:
  S6_INSTALL_DIR    installation directory (default: ~/s6_cut)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --remove-images) REMOVE_IMAGES=1 ;;
    --purge) PURGE=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo
      usage
      exit 2
      ;;
  esac
done

if [[ "$PURGE" -eq 1 && "$YES" -ne 1 ]]; then
  fail "--purge deletes the installation directory including your data and is irreversible."
  fail "Re-run with --purge --yes to confirm."
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" || ! -f "$INSTALL_DIR/$COMPOSE_FILE" ]]; then
  echo "S6_cut does not appear to be installed at $INSTALL_DIR — nothing to do."
  exit 0
fi

info "S6_cut Uninstaller"
echo "  Install directory: $INSTALL_DIR"

cd "$INSTALL_DIR"

if [[ "$REMOVE_IMAGES" -eq 1 ]]; then
  step "Removing S6_cut Docker images..."
  docker compose down --rmi local
else
  step "Stopping and removing S6_cut containers..."
  docker compose down
fi
ok "S6_cut containers stopped and removed"

if [[ "$PURGE" -eq 1 ]]; then
  step "Deleting the installation directory (including your data)..."
  cd "$HOME"
  rm -rf -- "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"
  echo
  ok "S6_cut fully removed."
else
  echo
  ok "S6_cut uninstalled. Your data, media, outputs, models, and .env are preserved at:"
  echo "  $INSTALL_DIR"
  echo "To run S6_cut again, re-run the install command. To delete everything, re-run uninstall.sh --purge --yes."
fi
