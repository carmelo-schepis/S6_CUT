# S6_CUT Cursor Automations (Terraform)

Config-as-code for the six Carmelo automations on `carmelo-schepis/S6_CUT`, patched so agents:

1. Run install/verification in the Cloud Agent environment (`skip_install` false).
2. May open GitHub PRs (`git_pr` action; `open_git_pr` not disabled).
3. Follow the **Delivery policy** appended to each prompt (`policy-delivery.md`).

## Automations

| Terraform resource | Automation ID | Name |
| --- | --- | --- |
| `fix_ci_failures` | `0ef02d7a-e4a2-11f1-9535-02900022bdcd` | Fix CI failures |
| `scan_vulnerabilities_scheduled` | `04d57bc5-e4a1-11f1-9535-02900022bdcd` | Scan codebase for vulnerabilities |
| `scan_vulnerabilities_alt` | `d74aab74-e4a1-11f1-9535-02900022bdcd` | Scan codebase for vulnerabilities |
| `monitor_env_build_health` | `eec7fc3f-e4a1-11f1-9535-02900022bdcd` | Monitor environment build health |
| `monitor_engineering_invariants` | `ae23d2cd-e4a1-11f1-9535-02900022bdcd` | Monitor engineering invariants |
| `find_critical_bugs` | `809fa49e-e4a1-11f1-9535-02900022bdcd` | Find critical bugs |

Cloud Agent environment id (S6_CUT): `7a28f83d-e4a1-11f1-9535-02900022bdcd`.

## Apply (requires token)

The Cloud Agent VM did **not** have `CURSOR_TOKEN` / `CURSOR_API_KEY`. Run locally or in CI with a **team service account** key ([Terraform provider docs](https://registry.terraform.io/providers/cursor/cursor/latest/docs)):

```bash
cd cursor/automations
export CURSOR_TOKEN='key_…'   # or crsr_…
chmod +x scripts/apply-pr-policy.sh
./scripts/apply-pr-policy.sh
```

What the script does:

1. `terraform init` with `cursor/cursor` ~> 0.8.
2. `terraform plan -generate-config-out` — imports each automation by ID (`imports.tf`), reads full remote config.
3. `scripts/patch_workflows_hcl.py` — removes `open_git_pr` from `disabled_default_tools`, sets `skip_install = false`, adds `action { git_pr = {} }` if missing, appends `policy-delivery.md` to prompts (deduped by header).
4. `terraform apply` — pushes changes only via Terraform; triggers/models/scope are preserved from generated config except those fields.

Dry-run without apply:

```bash
export CURSOR_TOKEN='…'
terraform init
terraform plan -generate-config-out=generated/workflows.generated.tf
python3 scripts/patch_workflows_hcl.py generated/workflows.generated.tf -o workflows.tf
terraform plan
```

## Repo verification (for automation prompts)

When automations change code, the delivery policy expects at least:

```bash
npm run check
```

(`lint`, `typecheck`, `vitest`, engine tests, and `build` per `package.json`.)

## Single source of truth

After the first apply, keep using Terraform for edits. UI changes will show as drift on the next `terraform plan`.