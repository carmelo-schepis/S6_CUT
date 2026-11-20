#!/usr/bin/env bash
# Sync Carmelo S6_CUT automations from Cursor, patch PR/test policy, and apply.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${CURSOR_TOKEN:-}" && -z "${CURSOR_API_KEY:-}" ]]; then
  echo "error: set CURSOR_TOKEN (or CURSOR_API_KEY) to a team service-account key." >&2
  exit 1
fi
export CURSOR_TOKEN="${CURSOR_TOKEN:-$CURSOR_API_KEY}"

GENERATED="$ROOT/generated"
mkdir -p "$GENERATED"

echo "==> terraform init"
terraform init -input=false

GENERATED_HCL="$GENERATED/workflows.generated.tf"
PATCHED_HCL="$ROOT/workflows.tf"

echo "==> import + generate config from Cursor API"
terraform plan -input=false -generate-config-out="$GENERATED_HCL"

if [[ ! -f "$GENERATED_HCL" ]]; then
  echo "error: generate-config-out did not produce $GENERATED_HCL" >&2
  exit 1
fi

echo "==> patch workflows (git_pr action, skip_install, delivery policy)"
python3 "$ROOT/scripts/patch_workflows_hcl.py" "$GENERATED_HCL" -o "$PATCHED_HCL"

echo "==> plan"
terraform plan -input=false -out="$GENERATED/plan.tfplan"

echo "==> apply (updates all six automations)"
terraform apply -input=false "$GENERATED/plan.tfplan"

echo "Done. Review automations on https://cursor.com/automations"