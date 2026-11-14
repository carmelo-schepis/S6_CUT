#!/usr/bin/env bash
#
# S6_cut uninstaller for TrueNAS SCALE
# ====================================
# Deletes the S6_cut Custom App. The source and data datasets are kept unless
# you explicitly ask for them to be destroyed:
#
#   sudo bash uninstall-truenas.sh                  delete the app, keep datasets
#   sudo bash uninstall-truenas.sh --remove-images  also remove the app's images
#   sudo bash uninstall-truenas.sh --purge          also destroy <pool>/apps/<app>
#                                                   (asks for confirmation)
#   sudo bash uninstall-truenas.sh --purge --yes    destroy without asking
#
# Environment overrides (same as install-truenas.sh):
#   S6_POOL      pool holding the datasets (default: the Apps pool)
#   S6_APP_NAME  TrueNAS app name          (default: s6-cut)

set -euo pipefail

APP_NAME="${S6_APP_NAME:-s6-cut}"
REMOVE_IMAGES=false
PURGE=false
YES=false

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
Usage: uninstall-truenas.sh [options]

Options:
  --remove-images   Also remove the Docker images the app used.
  --purge           Also destroy the <pool>/apps/<app> dataset with its source
                    and data children (projects, Library, media, models, .env).
                    Prints the exact datasets and asks you to type the name.
  --yes             Skip the --purge confirmation.
  -h, --help        Show this help.

Without options the app is deleted and every dataset is kept, so re-running
install-truenas.sh brings S6_cut back with its data.

Environment:
  S6_POOL           pool holding the datasets (default: the Apps pool)
  S6_APP_NAME       TrueNAS app name (default: s6-cut)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --remove-images) REMOVE_IMAGES=true ;;
    --purge) PURGE=true ;;
    --yes) YES=true ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
done

json_eval() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
r = eval(sys.argv[1], {"d": d})
if isinstance(r, (list, tuple)):
    for item in r:
        print(item)
elif r is not None:
    print(r)
' "$1"
}

print_datasets() {
  local line
  while IFS= read -r line; do
    printf '    %s\n' "$line"
  done <<<"$datasets"
}

json_filter() {
  python3 -c 'import json, sys; print(json.dumps([[sys.argv[1], "=", sys.argv[2]]]))' "$1" "$2"
}

[[ "$(id -u)" == "0" ]] || die "This uninstaller must run as root: sudo bash $0"
command -v midclt >/dev/null 2>&1 \
  || die "This does not look like TrueNAS SCALE (no 'midclt'). On other hosts use uninstall.sh."
[[ "$APP_NAME" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || die "S6_APP_NAME '$APP_NAME' is not a valid app name."

info "S6_cut Uninstaller for TrueNAS SCALE"

# A failed query must not read as "not installed": --purge would then destroy
# the datasets of a running app.
installed="$(midclt call app.query "$(json_filter name "$APP_NAME")" | json_eval '[a["name"] for a in d]')" \
  || die "Could not ask TrueNAS which apps are installed (is the middleware running?). Nothing was changed."
if [[ -n "$installed" ]]; then
  step "Deleting the TrueNAS app '$APP_NAME'..."
  midclt call -j app.delete "$APP_NAME" \
    "{\"remove_images\": $REMOVE_IMAGES, \"remove_ix_volumes\": false}" >/dev/null \
    || die "TrueNAS could not delete the app. Try Apps -> Installed -> $APP_NAME -> Delete, then re-run. Datasets were not touched."
  ok "App '$APP_NAME' deleted"
else
  ok "No TrueNAS app named '$APP_NAME' is installed"
fi

POOL="${S6_POOL:-}"
if [[ -z "$POOL" ]]; then
  POOL="$(midclt call docker.config | json_eval 'd.get("pool") or ""')"
fi
if [[ -z "$POOL" ]]; then
  ROOT_DS=""
  warn "Could not determine the Apps pool; set S6_POOL to locate the datasets."
else
  ROOT_DS="$POOL/apps/$APP_NAME"
fi

datasets=""
if [[ -n "$ROOT_DS" ]]; then
  datasets="$(midclt call pool.dataset.query "$(json_filter id "$ROOT_DS")" '{"extra": {"retrieve_children": true}}' \
    | json_eval '[x["id"] + "  (" + str(x.get("mountpoint") or "not mounted") + ")" for r in d for x in [r] + r.get("children", [])]')" \
    || die "Could not look up dataset $ROOT_DS. Nothing was destroyed."
fi

if [[ "$PURGE" != true ]]; then
  echo
  if [[ -n "$datasets" ]]; then
    ok "S6_cut uninstalled. Your datasets are kept:"
    print_datasets
    echo "  Re-run install-truenas.sh to bring S6_cut back with this data."
    echo "  To destroy them as well: sudo bash uninstall-truenas.sh --purge"
  else
    ok "S6_cut uninstalled."
  fi
  exit 0
fi

if [[ -z "$datasets" ]]; then
  ok "No dataset ${ROOT_DS:-<pool>/apps/$APP_NAME} found; nothing to purge."
  exit 0
fi

echo
warn "--purge permanently destroys these datasets, including every project, Library item, media file, model and .env:"
print_datasets
if [[ "$YES" != true ]]; then
  answer=""
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    die "No terminal to confirm on. Re-run with --purge --yes to destroy ${ROOT_DS}. Nothing was destroyed."
  fi
  printf '  Type %s to destroy it: ' "$ROOT_DS" > /dev/tty
  read -r answer <&3 || true
  exec 3<&-
  [[ "$answer" == "$ROOT_DS" ]] || die "Confirmation did not match. Nothing was destroyed."
fi

step "Destroying dataset $ROOT_DS and its children..."
midclt call pool.dataset.delete "$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$ROOT_DS")" '{"recursive": true}' >/dev/null \
  || die "Could not destroy $ROOT_DS. Check that nothing else (an SMB/NFS share, another app) uses it, then re-run with --purge."
ok "Destroyed $ROOT_DS"
echo
ok "S6_cut fully removed."
