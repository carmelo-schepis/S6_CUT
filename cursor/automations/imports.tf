# Adopt existing Carmelo automations for S6_CUT. Config is generated on first sync
# (see scripts/apply-pr-policy.sh) then patched in workflows.tf.

import {
  to = cursor_platform_workflow.fix_ci_failures
  id = "0ef02d7a-e4a2-11f1-9535-02900022bdcd"
}

import {
  to = cursor_platform_workflow.scan_vulnerabilities_scheduled
  id = "04d57bc5-e4a1-11f1-9535-02900022bdcd"
}

import {
  to = cursor_platform_workflow.scan_vulnerabilities_alt
  id = "d74aab74-e4a1-11f1-9535-02900022bdcd"
}

import {
  to = cursor_platform_workflow.monitor_env_build_health
  id = "eec7fc3f-e4a1-11f1-9535-02900022bdcd"
}

import {
  to = cursor_platform_workflow.monitor_engineering_invariants
  id = "ae23d2cd-e4a1-11f1-9535-02900022bdcd"
}

import {
  to = cursor_platform_workflow.find_critical_bugs
  id = "809fa49e-e4a1-11f1-9535-02900022bdcd"
}