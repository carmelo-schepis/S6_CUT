#!/usr/bin/env bash
#
# S6_cut installer for TrueNAS SCALE (24.10+, Docker-based Apps)
# ===============================================================
# Paste into System -> Shell (or an SSH session):
#
#   curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install-truenas.sh | sudo bash
#
# Installs S6_cut as a TrueNAS Custom App that appears under Apps -> Installed,
# with its source and data on ZFS datasets in the Apps pool:
#
#   <pool>/apps/<app>          parent dataset (also holds truenas-app.yaml)
#   <pool>/apps/<app>/source   git checkout, .env
#   <pool>/apps/<app>/data     projects, Library, media, models (UID 10001)
#
# Safe to run repeatedly: a re-run updates the source, rebuilds the images and
# updates the app. .env and the data dataset are never overwritten.
#
# Environment overrides (sudo strips the environment, so put them after sudo:
# `... | sudo S6_PORT=30200 bash`):
#   S6_POOL           pool for the datasets    (default: the Apps pool)
#   S6_PORT           web port on the LAN      (default: 30180, or the next free port)
#   S6_APP_NAME       TrueNAS app name         (default: s6-cut)
#   S6_REPO_URL       repository to install    (default: https://github.com/carmelo-schepis/S6_CUT.git)
#   S6_BRANCH         branch to track          (default: main)
#   S6_START_TIMEOUT  seconds to wait for web  (default: 600)

set -Eeuo pipefail

APP_NAME="${S6_APP_NAME:-s6-cut}"
REPO_URL="${S6_REPO_URL:-https://github.com/carmelo-schepis/S6_CUT.git}"
BRANCH="${S6_BRANCH:-main}"
START_TIMEOUT="${S6_START_TIMEOUT:-600}"
DEFAULT_PORT=30180
ENGINE_UID=10001
# Where TrueNAS keeps each app's rendered compose files.
APP_CONFIGS_DIR="${S6_TRUENAS_APP_CONFIGS:-/mnt/.ix-apps/app_configs}"
GIT_IMAGE="alpine/git:2.54.0@sha256:4fac439ee3b9204bec99c712b8a15942999632458f716ae8149fbb97cb760cd4"
CURRENT_STEP="starting"
GIT_VIA_DOCKER=false
POOL=""
ROOT_DS=""
ROOT_DIR=""
SOURCE_DIR=""
DATA_DIR=""
APP_YAML=""
WEB_PORT=""
PROJECT=""
USED_PORTS=""
DS_MOUNT=""
APP_JOB_LOG=""
APP_JOB_KIND=other

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

# Like die, after printing container diagnostics.
abort() {
  trap - ERR
  fail "$*"
  show_diagnostics
  echo
  echo "Fix the cause above and re-run the same command; a re-run is safe and keeps your data."
  exit 1
}

show_diagnostics() {
  [[ -n "$PROJECT" ]] || return 0
  echo
  info "Diagnostics: containers of $PROJECT"
  docker compose -p "$PROJECT" ps -a 2>/dev/null || true
  echo
  info "Diagnostics: recent container logs"
  docker compose -p "$PROJECT" logs --tail=60 2>/dev/null || true
  if [[ -r /var/log/app_lifecycle.log ]]; then
    echo
    info "Diagnostics: /var/log/app_lifecycle.log (last lines)"
    tail -n 20 /var/log/app_lifecycle.log || true
  fi
}

report_failure() {
  local code=$?
  trap - ERR
  fail "S6_cut installation failed while ${CURRENT_STEP} (exit $code)."
  show_diagnostics
  echo
  echo "Fix the cause above and re-run the same command; a re-run is safe and keeps your data."
  exit "$code"
}
trap report_failure ERR

# --- helpers ------------------------------------------------------------------

# json_eval EXPR: evaluate a Python expression on the JSON document read from
# stdin (bound to `d`) and print the result. Lists print one item per line.
json_eval() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
r = eval(sys.argv[1], {"d": d})
if r is None:
    pass
elif isinstance(r, (list, tuple, set)):
    for item in r:
        print(item)
elif isinstance(r, bool):
    print("true" if r else "false")
else:
    print(r)
' "$1"
}

# json_object KEY VALUE ...: print a JSON object of string values. A value of
# the form @json:<literal> is embedded as JSON (true, false, numbers).
json_object() {
  python3 -c '
import json, sys
args = sys.argv[1:]
out = {}
for key, value in zip(args[0::2], args[1::2]):
    out[key] = json.loads(value[6:]) if value.startswith("@json:") else value
print(json.dumps(out))
' "$@"
}

mid() { midclt call "$@"; }

dataset_mountpoint() {
  local filter
  filter="$(python3 -c 'import json, sys; print(json.dumps([["id", "=", sys.argv[1]]]))' "$1")"
  # Prints nothing for a missing dataset and "-" for one without a mountpoint.
  mid pool.dataset.query "$filter" | json_eval '(d[0].get("mountpoint") or "-") if d else ""'
}

set_env_value() {
  local file="$1" name="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  awk -v n="$name" -v v="$value" '
    BEGIN { done = 0 }
    index($0, n "=") == 1 { if (!done) { print n "=" v; done = 1 } next }
    { print }
    END { if (!done) print n "=" v }
  ' "$file" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

env_value() {
  local file="$1" name="$2"
  { grep -E "^${name}=" "$file" 2>/dev/null || true; } | tail -n1 | cut -d= -f2- | tr -d "\"'"
}

port_of_binding() {
  local port="${1##*:}"
  if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
    die "S6_PORT must be a port number (1-65535) or an IP:port binding, got '$1'."
  fi
  printf '%s' "$((10#$port))"
}

# Host ports published in the rendered compose files of the other apps. app.query
# reports no ports for a stopped app, but its port is taken again when it starts.
configured_app_ports() {
  python3 -c '
import glob, os, re, sys
root, own = sys.argv[1:3]
try:
    import yaml
except ImportError:
    sys.exit(0)
for path in glob.glob(os.path.join(root, "*", "versions", "*", "templates", "rendered", "*.y*ml")):
    if os.path.relpath(path, root).split(os.sep)[0] == own:
        continue
    try:
        services = (yaml.safe_load(open(path)) or {}).get("services") or {}
    except Exception:
        continue
    for service in services.values():
        for port in (service or {}).get("ports") or []:
            if isinstance(port, dict):
                published = str(port.get("published", ""))
            else:
                parts = str(port).split("/")[0].rsplit(":", 2)
                published = parts[-2] if len(parts) > 1 else ""
            match = re.fullmatch(r"(\d+)(?:-(\d+))?", published)
            if match:
                first = int(match.group(1))
                for value in range(first, int(match.group(2) or first) + 1):
                    print(value)
' "$APP_CONFIGS_DIR" "$APP_NAME" 2>/dev/null || true
}

# Ports in use on the NAS: listening sockets plus ports published by other apps,
# running or stopped.
collect_used_ports() {
  local listening apps_ports configured
  listening="$(ss -Hltn 2>/dev/null | awk '{ n = split($4, a, ":"); print a[n] }' || true)"
  apps_ports="$(mid app.query | json_eval '[hp["host_port"] for app in d if app.get("name") != "'"$APP_NAME"'" for p in (app.get("active_workloads") or {}).get("used_ports", []) for hp in p.get("host_ports", [])]' || true)"
  configured="$(configured_app_ports)"
  USED_PORTS="$(printf '%s\n%s\n%s\n' "$listening" "$apps_ports" "$configured" | grep -E '^[0-9]+$' | sort -un || true)"
}

port_used() {
  grep -qx "$1" <<<"$USED_PORTS"
}

pick_free_port() {
  local port="$1" skip="${2:-}"
  while port_used "$port" || [[ "$port" == "$skip" ]]; do
    port=$((port + 1))
    (( port <= 65535 )) || die "No free TCP port found above $1. Set S6_PORT explicitly."
  done
  printf '%s' "$port"
}

# --- checks -------------------------------------------------------------------

check_root() {
  CURRENT_STEP="checking permissions"
  [[ "$(id -u)" == "0" ]] || die "This installer must run as root. Use: curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install-truenas.sh | sudo bash"
}

check_truenas() {
  CURRENT_STEP="detecting TrueNAS SCALE"
  local version="" major minor
  if ! command -v midclt >/dev/null 2>&1; then
    die "This does not look like TrueNAS SCALE (the 'midclt' middleware client is missing). On other Linux or macOS hosts use install.sh instead: curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install.sh | bash"
  fi
  version="$(mid system.info 2>/dev/null | json_eval 'd.get("version", "")' 2>/dev/null || true)"
  if [[ -z "$version" && -r /etc/version ]]; then
    version="$(head -n1 /etc/version)"
  fi
  if [[ ! "$version" =~ ([0-9]{2})\.([0-9]{2}) ]]; then
    die "Could not determine the TrueNAS version (got '${version:-nothing}'). This installer needs TrueNAS SCALE 24.10 or newer; on other hosts use install.sh."
  fi
  major="$((10#${BASH_REMATCH[1]}))"
  minor="$((10#${BASH_REMATCH[2]}))"
  if (( major < 24 || (major == 24 && minor < 10) )); then
    die "TrueNAS $version uses Kubernetes-based Apps. S6_cut needs TrueNAS SCALE 24.10 or newer (Docker-based Apps); 25.04+ is recommended."
  fi
  ok "TrueNAS SCALE $version detected"
  (( major > 24 )) || warn "TrueNAS 24.10 is accepted but untested; 25.04 or newer is recommended."

  command -v python3 >/dev/null 2>&1 || die "python3 is missing; it ships with TrueNAS SCALE, so this system looks incomplete."
  command -v docker >/dev/null 2>&1 || die "docker is missing. Configure Apps (Apps -> Configuration -> Choose Pool) and re-run."
  docker info >/dev/null 2>&1 || die "The Docker engine is not running. Open Apps, make sure the Apps service is configured and running, then re-run."
  docker compose version >/dev/null 2>&1 || die "'docker compose' is not available on this system."
  ok "Docker engine is running"
  if command -v git >/dev/null 2>&1; then
    ok "Git found"
  else
    GIT_VIA_DOCKER=true
    step "Using Git inside Docker (no host Git found)"
  fi
}

validate_settings() {
  CURRENT_STEP="validating settings"
  [[ "$APP_NAME" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ && ${#APP_NAME} -le 40 ]] \
    || die "S6_APP_NAME '$APP_NAME' is not a valid TrueNAS app name (lowercase letters, digits and dashes, starting with a letter, at most 40 characters)."
  [[ "$START_TIMEOUT" =~ ^[0-9]+$ ]] || die "S6_START_TIMEOUT must be a number of seconds."
  PROJECT="ix-${APP_NAME}"
}

# --- storage ------------------------------------------------------------------

detect_pool() {
  CURRENT_STEP="detecting the Apps pool"
  if [[ -n "${S6_POOL:-}" ]]; then
    POOL="$S6_POOL"
    step "Using pool '$POOL' from S6_POOL"
  else
    POOL="$(mid docker.config | json_eval 'd.get("pool") or ""')"
    [[ -n "$POOL" ]] || die "The Apps service has no pool yet. In the TrueNAS UI open Apps -> Configuration -> Choose Pool, then re-run (or set S6_POOL)."
  fi
  [[ "$POOL" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die "Pool name '$POOL' is not valid."
  [[ -n "$(dataset_mountpoint "$POOL")" ]] || die "Pool '$POOL' was not found. Check the name under Storage, or unset S6_POOL."
  ok "Apps pool: $POOL"
}

ensure_dataset() {
  local name="$1" payload mountpoint
  mountpoint="$(dataset_mountpoint "$name")"
  if [[ -n "$mountpoint" ]]; then
    ok "Dataset $name exists"
  else
    payload="$(json_object name "$name" type FILESYSTEM share_type GENERIC)"
    mid pool.dataset.create "$payload" >/dev/null \
      || die "Could not create dataset $name. Check the pool's free space and that the name is not taken, then re-run."
    mountpoint="$(dataset_mountpoint "$name")"
    ok "Created dataset $name"
  fi
  [[ "$mountpoint" != "-" && -d "$mountpoint" ]] || die "Dataset $name is not mounted (mountpoint '${mountpoint:-none}'). Mount or unlock it, then re-run."
  DS_MOUNT="$mountpoint"
}

prepare_datasets() {
  CURRENT_STEP="creating datasets"
  ROOT_DS="$POOL/apps/$APP_NAME"
  ensure_dataset "$POOL/apps"
  ensure_dataset "$ROOT_DS"
  ROOT_DIR="$DS_MOUNT"
  ensure_dataset "$ROOT_DS/source"
  SOURCE_DIR="$DS_MOUNT"
  ensure_dataset "$ROOT_DS/data"
  DATA_DIR="$DS_MOUNT"
  APP_YAML="$ROOT_DIR/truenas-app.yaml"
}

# --- source -------------------------------------------------------------------

source_git() {
  if [[ "$GIT_VIA_DOCKER" == "true" ]]; then
    docker run --rm -e HOME=/tmp \
      --mount "type=bind,source=$SOURCE_DIR,target=/s6_cut" \
      --workdir /s6_cut "$GIT_IMAGE" -c safe.directory=/s6_cut "$@"
  else
    git -C "$SOURCE_DIR" -c safe.directory="$SOURCE_DIR" "$@"
  fi
}

prepare_source() {
  CURRENT_STEP="downloading S6_cut"
  if [[ -d "$SOURCE_DIR/.git" ]]; then
    step "Updating the source in $SOURCE_DIR to the latest $BRANCH..."
    if source_git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; then
      source_git reset --quiet --hard "origin/$BRANCH"
      ok "Source updated to $(source_git rev-parse --short HEAD)"
    else
      warn "Could not reach $REPO_URL. Keeping the current source ($(source_git rev-parse --short HEAD))."
    fi
  elif [[ -n "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ]]; then
    die "$SOURCE_DIR is not empty and is not a git checkout. Move its contents aside, then re-run."
  else
    step "Downloading S6_cut into $SOURCE_DIR..."
    source_git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" .
    ok "Source downloaded ($(source_git rev-parse --short HEAD))"
  fi
  [[ -f "$SOURCE_DIR/compose.yaml" ]] || die "$SOURCE_DIR has no compose.yaml; the download looks incomplete. Delete the contents of the source dataset and re-run."
}

# --- configuration ------------------------------------------------------------

prepare_environment() {
  CURRENT_STEP="preparing configuration"
  local env_file="$SOURCE_DIR/.env" port current engine_port fresh=false
  collect_used_ports
  if [[ ! -f "$env_file" ]]; then
    fresh=true
    if [[ -f "$SOURCE_DIR/.env.example" ]]; then
      cp "$SOURCE_DIR/.env.example" "$env_file"
    else
      : > "$env_file"
    fi
  fi
  chmod 600 "$env_file"

  if [[ "$fresh" == true || -z "$(env_value "$env_file" S6_DATA_PATH)" ]]; then
    set_env_value "$env_file" S6_DATA_PATH "$DATA_DIR"
  fi

  if [[ -n "${S6_PORT:-}" ]]; then
    port="$(port_of_binding "$S6_PORT")"
    current="$(env_value "$env_file" S6_PORT)"
    # The app's own published port is excluded from the used list on a re-run.
    if [[ "$fresh" == true || "${current##*:}" != "$port" ]] && port_used "$port"; then
      die "Port $port (S6_PORT) is already in use on this NAS. Choose another port, for example: ... | sudo S6_PORT=$(pick_free_port "$port") bash"
    fi
    set_env_value "$env_file" S6_PORT "$S6_PORT"
  elif [[ "$fresh" == true || -z "$(env_value "$env_file" S6_PORT)" ]]; then
    port="$(pick_free_port "$DEFAULT_PORT")"
    [[ "$port" == "$DEFAULT_PORT" ]] || warn "Port $DEFAULT_PORT is in use; using $port instead."
    set_env_value "$env_file" S6_PORT "$port"
  fi
  WEB_PORT="$(port_of_binding "$(env_value "$env_file" S6_PORT)")"

  # The engine's loopback debug port also has to be free on the host.
  if [[ "$fresh" == true ]]; then
    engine_port="$(env_value "$env_file" S6_ENGINE_PORT)"
    engine_port="${engine_port:-8001}"
    if port_used "$engine_port"; then
      engine_port="$(pick_free_port "$((DEFAULT_PORT + 1))" "$WEB_PORT")"
      warn "Engine debug port 8001 is in use; using 127.0.0.1:$engine_port instead."
      set_env_value "$env_file" S6_ENGINE_PORT "$engine_port"
    fi
  fi

  if [[ "$fresh" == true ]]; then
    ok "Configuration created ($env_file)"
  else
    ok "Configuration preserved ($env_file)"
  fi
}

prepare_permissions() {
  CURRENT_STEP="setting data permissions"
  local data_path
  data_path="$(env_value "$SOURCE_DIR/.env" S6_DATA_PATH)"
  if [[ "$data_path" != /* ]]; then
    warn "S6_DATA_PATH in .env is relative ('$data_path'); resolving it inside the source dataset."
    data_path="$SOURCE_DIR/${data_path#./}"
    mkdir -p "$data_path"
  fi
  [[ -d "$data_path" ]] || die "S6_DATA_PATH '$data_path' does not exist. Fix it in $SOURCE_DIR/.env and re-run."
  # Only hand over what is not already the engine's, like the data-init service.
  find "$data_path" ! -user "$ENGINE_UID" -exec chown -h "$ENGINE_UID:$ENGINE_UID" {} + \
    || die "Could not give UID $ENGINE_UID ownership of $data_path. If the dataset has a restrictive ACL, set its ACL type to POSIX (Datasets -> Edit -> Advanced) or grant UID $ENGINE_UID full control, then re-run."
  ok "Data dataset writable by the engine (UID $ENGINE_UID): $data_path"
}

render_app_yaml() {
  CURRENT_STEP="rendering the app configuration"
  local revision tmp var
  local -a clean_env=()
  # .env is the single source of configuration: drop exported overrides so the
  # rendered app matches what a later re-run renders.
  while IFS= read -r var; do
    clean_env+=(-u "$var")
  done < <(compgen -e | grep -E '^(S6_|OPENROUTER_API_KEY$)' || true)
  revision="$(source_git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  tmp="$(mktemp "${APP_YAML}.XXXXXX")"
  chmod 600 "$tmp"
  # A fully resolved file: TrueNAS stores the app's compose file under
  # /mnt/.ix-apps, so relative paths, include: and .env lookups cannot be relied
  # on. Build contexts and the data bind mount resolve to absolute dataset paths.
  (cd "$SOURCE_DIR" && env "${clean_env[@]}" S6_BUILD_REVISION="$revision" \
    docker compose --project-directory "$SOURCE_DIR" -f "$SOURCE_DIR/compose.yaml" \
      --env-file "$SOURCE_DIR/.env" -p "$PROJECT" config) > "$tmp" \
    || { rm -f "$tmp"; die "docker compose could not resolve $SOURCE_DIR/compose.yaml with $SOURCE_DIR/.env. Fix the error above and re-run."; }
  mv "$tmp" "$APP_YAML"
  ok "App configuration rendered: $APP_YAML"
}

build_images() {
  CURRENT_STEP="building the images"
  step "Building the S6_cut images on the NAS (the first build can take 10+ minutes)..."
  # Same file and project name TrueNAS deploys with, so the images are tagged
  # ix-<app>-engine, ix-<app>-web, ... and the app's deploy does not rebuild.
  docker compose -p "$PROJECT" -f "$APP_YAML" build
  step "Pulling the prebuilt pot-provider image..."
  docker compose -p "$PROJECT" -f "$APP_YAML" pull pot-provider
  ok "Images ready"
}

# --- app ----------------------------------------------------------------------

app_state() {
  local filter
  filter="$(python3 -c 'import json, sys; print(json.dumps([["name", "=", sys.argv[1]]]))' "$APP_NAME")"
  mid app.query "$filter" | json_eval 'd[0].get("state", "UNKNOWN") if d else ""'
}

app_payload() {
  # $1: create | update; $2: string | dict
  python3 -c '
import json, sys
mode, form, name, path = sys.argv[1:5]
text = open(path).read()
if form == "dict":
    import yaml
    config = {"custom_compose_config": yaml.safe_load(text)}
else:
    config = {"custom_compose_config_string": text}
if mode == "create":
    config.update({"app_name": name, "custom_app": True})
print(json.dumps(config))
' "$1" "$2" "$APP_NAME" "$APP_YAML"
}

# The app job (app.create / app.update) is sent through TrueNAS's middleware
# Python client in this process. The compose payload never goes on a command
# line: on TrueNAS, sudo stops a midclt call whose argv is too long ("sudo:
# argv[N] mismatch") and the app is not created. The payload is read from
# $APP_YAML (mode 0600) by the helper. Exit 3 when no client module is importable.
mid_app_job() {
  python3 -c '
import json, sys
mode, form, name, path = sys.argv[1:5]
try:
    from truenas_api_client import Client
except ImportError:
    try:
        from middlewared.client import Client
    except ImportError:
        print("No TrueNAS middleware Python client is importable.", file=sys.stderr)
        sys.exit(3)
text = open(path).read()
if form == "dict":
    import yaml
    config = {"custom_compose_config": yaml.safe_load(text)}
else:
    config = {"custom_compose_config_string": text}
if mode == "create":
    config.update({"app_name": name, "custom_app": True})
    params = [config]
else:
    params = [name, config]
shown = [None]
def progress(job):
    desc = (job.get("progress") or {}).get("description")
    if desc and desc != shown[0]:
        shown[0] = desc
        print(desc, file=sys.stderr, flush=True)
try:
    with Client() as client:
        client.call("app." + mode, *params, job=True, callback=progress)
except Exception as e:
    print(f"{type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
' "$@"
}

# attempt_app_job MODE FORM: one job through the middleware client; output to $APP_JOB_LOG.
attempt_app_job() {
  local status=0
  mid_app_job "$1" "$2" "$APP_NAME" "$APP_YAML" 2>&1 | tee "$APP_JOB_LOG" || status=$?
  return "$status"
}

# attempt_midclt_app_job MODE FORM: the same job through midclt. Only the fallback
# for systems without the Python client; midclt takes the payload on its command line.
attempt_midclt_app_job() {
  local mode="$1" form="$2" status=0
  local -a args=(-j "app.$mode")
  [[ "$mode" == update ]] && args+=("$APP_NAME")
  mid "${args[@]}" "$(app_payload "$mode" "$form")" 2>&1 | tee "$APP_JOB_LOG" || status=$?
  return "$status"
}

# TrueNAS's sudo stops a midclt call whose argv is too long. $1: transport, $2: exit status.
app_job_sudo_killed() {
  [[ "$1" == midclt ]] && { (( $2 == 137 )) || grep -qE 'argv\[[0-9]+\] mismatch' "$APP_JOB_LOG"; }
}

# run_app_job MODE: create or update the app. Retries once with the parsed
# configuration only if this middleware rejects the YAML string field itself.
# Sets APP_JOB_KIND to sudo, port or other when the job fails.
run_app_job() {
  local mode="$1" status=0 transport=client
  APP_JOB_LOG="$(mktemp)"
  attempt_app_job "$mode" string || status=$?
  if (( status == 3 )); then
    transport=midclt
    warn "TrueNAS's Python middleware client cannot be imported; falling back to midclt."
    status=0
    attempt_midclt_app_job "$mode" string || status=$?
  fi
  if (( status != 0 )) && ! app_job_sudo_killed "$transport" "$status" \
      && grep -q 'custom_compose_config_string' "$APP_JOB_LOG"; then
    warn "This TrueNAS version rejected the YAML string; retrying with the parsed configuration."
    status=0
    if [[ "$transport" == client ]]; then
      attempt_app_job "$mode" dict || status=$?
    else
      attempt_midclt_app_job "$mode" dict || status=$?
    fi
  fi
  APP_JOB_KIND=other
  if (( status != 0 )); then
    if app_job_sudo_killed "$transport" "$status"; then
      APP_JOB_KIND=sudo
    elif grep -qiE 'already allocated|address already in use|port [0-9]+ .*in use|port is already' "$APP_JOB_LOG"; then
      APP_JOB_KIND=port
    fi
  fi
  rm -f "$APP_JOB_LOG"
  return "$status"
}

# app_job_failed VERB: explain a failed app.create or app.update, then exit.
app_job_failed() {
  local verb="$1" fallback
  if [[ "$verb" == create ]]; then
    fallback="Manual fallback: Apps -> Discover Apps -> ⋮ -> Install via YAML, name '$APP_NAME', paste $APP_YAML"
  else
    fallback="Manual fallback: Apps -> Installed -> $APP_NAME -> Edit, paste $APP_YAML"
  fi
  case "$APP_JOB_KIND" in
    sudo)
      abort "TrueNAS could not $verb the app: its sudo stopped the midclt call because the app configuration is too large to pass on the command line (sudo argv mismatch). This system has no importable TrueNAS middleware Python client, so the job went through midclt. $fallback. Re-running this command is safe." ;;
    port)
      abort "TrueNAS could not $verb the app because a port is taken. Re-run with S6_PORT=<free port> after sudo. $fallback" ;;
    *)
      abort "TrueNAS could not $verb the app. $fallback" ;;
  esac
}

deploy_app() {
  local state
  state="$(app_state)"
  if [[ -z "$state" ]]; then
    CURRENT_STEP="creating the TrueNAS app '$APP_NAME'"
    step "Creating the TrueNAS app '$APP_NAME' (waits for the engine health check)..."
    run_app_job create || app_job_failed create
    ok "App '$APP_NAME' created"
  else
    CURRENT_STEP="updating the TrueNAS app '$APP_NAME'"
    step "Updating the TrueNAS app '$APP_NAME' (currently $state)..."
    run_app_job update || app_job_failed update
    # app.update recreates the containers of a running app itself; a stopped
    # app only gets its configuration saved, so start it with a redeploy.
    if [[ "$(app_state)" == "STOPPED" ]]; then
      step "Starting the stopped app with a redeploy..."
      mid -j app.redeploy "$APP_NAME"
    fi
    ok "App '$APP_NAME' updated"
  fi
}

wait_for_web() {
  CURRENT_STEP="waiting for S6_cut to become healthy"
  local deadline status="" last=""
  step "Waiting for the web service to report healthy (up to ${START_TIMEOUT}s; the engine needs about 2 minutes on first start)..."
  deadline=$(( $(date +%s) + START_TIMEOUT ))
  while true; do
    status="$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=web" --format '{{.Status}}')"
    status="${status%%$'\n'*}"
    if [[ "$status" == *"(healthy)"* ]]; then
      ok "S6_cut is healthy"
      return 0
    fi
    if [[ "$status" != "$last" ]]; then
      step "web: ${status:-not created yet}"
      last="$status"
    fi
    (( $(date +%s) < deadline )) || break
    sleep 5
  done
  abort "The web service was not healthy after ${START_TIMEOUT}s (last status: ${status:-none})."
}

lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  fi
  printf '%s' "${ip:-<NAS-IP>}"
}

print_summary() {
  local url
  url="http://$(lan_ip):${WEB_PORT}"
  echo
  ok "S6_cut is running as the TrueNAS app '$APP_NAME'"
  echo
  printf '  Open:      %s\n' "$url"
  printf '  Source:    %s  (dataset %s/source)\n' "$SOURCE_DIR" "$ROOT_DS"
  printf '  Data:      %s  (dataset %s/data)\n' "$DATA_DIR" "$ROOT_DS"
  printf '  Settings:  %s/.env\n' "$SOURCE_DIR"
  echo
  info "Next steps"
  echo "  • Manage it under Apps -> Installed -> $APP_NAME (Start, Stop, Edit, Delete)."
  echo "  • Update: re-run the same install command. Your .env and data are kept."
  echo "  • After editing .env, re-run the install command to apply it."
  echo "  • Uninstall (keeps your data): sudo bash $SOURCE_DIR/uninstall-truenas.sh"
  echo
  warn "S6_cut has no authentication. Keep it on your LAN or a VPN and never port-forward $WEB_PORT from the internet."
}

main() {
  info "S6_cut Installer for TrueNAS SCALE"
  check_root
  validate_settings
  check_truenas
  detect_pool
  prepare_datasets
  prepare_source
  prepare_environment
  prepare_permissions
  render_app_yaml
  build_images
  deploy_app
  wait_for_web
  print_summary
}

main "$@"
