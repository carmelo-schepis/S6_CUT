locals {
  delivery_policy = trimspace(file("${path.module}/policy-delivery.md"))

  automations = {
    fix_ci_failures = {
      id   = "0ef02d7a-e4a2-11f1-9535-02900022bdcd"
      name = "Fix CI failures"
    }
    scan_vulnerabilities_scheduled = {
      id   = "04d57bc5-e4a1-11f1-9535-02900022bdcd"
      name = "Scan codebase for vulnerabilities"
    }
    scan_vulnerabilities_alt = {
      id   = "d74aab74-e4a1-11f1-9535-02900022bdcd"
      name = "Scan codebase for vulnerabilities"
    }
    monitor_env_build_health = {
      id   = "eec7fc3f-e4a1-11f1-9535-02900022bdcd"
      name = "Monitor environment build health"
    }
    monitor_engineering_invariants = {
      id   = "ae23d2cd-e4a1-11f1-9535-02900022bdcd"
      name = "Monitor engineering invariants"
    }
    find_critical_bugs = {
      id   = "809fa49e-e4a1-11f1-9535-02900022bdcd"
      name = "Find critical bugs"
    }
  }
}