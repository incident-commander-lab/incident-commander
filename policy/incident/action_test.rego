# Policy unit tests — run with:  opa test policy/ -v   (or, without opa installed:
#   docker run --rm -v "$PWD/policy:/policy:ro" openpolicyagent/opa:1.4.0-static test /policy -v)
#
# These pin the autonomy boundary. If a change to action.rego lets a forbidden
# action through, or blocks the reversible path, a test here fails before the
# live controller ever sees the new policy.
package incident.action_test

import rego.v1

import data.incident.action

rollback_input := {
    "mode": "live",
    "action": "rollback_deploy",
    "incident_id": "LIVE-TEST",
    "posterior": 0.97,
    "evidence_refs": ["deploy://checkout-service/deployments/v6.10.0"],
    "deploy_recent": true,
    "upstream_outage": false,
    "reversible": true,
    "blast_radius": "service",
    "confirmation": "positive",
    "verification_planned": true,
    "safety_envelope": {"auto_revert": true},
}

# --- reversible path executes autonomously ---------------------------------

test_rollback_with_positive_confirmation_allowed if {
    action.allow with input as rollback_input
}

test_rollback_by_exclusion_allowed_when_revert_and_verification_planned if {
    action.allow with input as object.union(rollback_input, {"confirmation": "exclusion_only"})
}

test_rollback_by_exclusion_denied_without_verification if {
    inp := object.union(rollback_input, {"confirmation": "exclusion_only", "verification_planned": false})
    not action.allow with input as inp
    "insufficient_confirmation" in action.reasons with input as inp
}

test_rollback_below_threshold_denied if {
    inp := object.union(rollback_input, {"posterior": 0.6})
    not action.allow with input as inp
    "posterior_below_remediation_threshold" in action.reasons with input as inp
}

test_rollback_without_recent_deploy_denied if {
    inp := object.union(rollback_input, {"deploy_recent": false})
    not action.allow with input as inp
    "deploy_not_recent" in action.reasons with input as inp
}

# --- forbidden actions are denied regardless of confidence ------------------

test_failover_database_denied_even_at_high_confidence if {
    inp := object.union(rollback_input, {
        "action": "failover_database",
        "posterior": 0.99,
        "reversible": false,
        "blast_radius": "shared_dependency",
    })
    not action.allow with input as inp
    "action_forbidden_by_policy" in action.reasons with input as inp
    "action_not_reversible" in action.reasons with input as inp
}

test_unknown_action_denied if {
    inp := object.union(rollback_input, {"action": "delete_all_pods"})
    not action.allow with input as inp
    "unknown_action_class" in action.reasons with input as inp
}

# --- interventional probe envelope -----------------------------------------

canary_input := {
    "mode": "live",
    "action": "canary_probe",
    "incident_id": "LIVE-TEST",
    "posterior": 0.5,
    "evidence_refs": ["deploy://checkout-service/deployments/v6.10.0"],
    "reversible": true,
    "blast_radius": "service",
    "safety_envelope": {"max_traffic_pct": 20, "max_duration_s": 8, "auto_revert": true},
}

test_canary_probe_within_envelope_allowed if {
    action.allow with input as canary_input
}

test_canary_probe_too_wide_denied if {
    inp := object.union(canary_input, {"safety_envelope": {"max_traffic_pct": 50, "max_duration_s": 8, "auto_revert": true}})
    not action.allow with input as inp
    "envelope_traffic_too_wide" in action.reasons with input as inp
}

test_canary_probe_without_auto_revert_denied if {
    inp := object.union(canary_input, {"safety_envelope": {"max_traffic_pct": 20, "max_duration_s": 8, "auto_revert": false}})
    not action.allow with input as inp
}

# --- auto-revert -----------------------------------------------------------

test_auto_revert_of_agent_action_allowed if {
    action.allow with input as {
        "mode": "live",
        "action": "auto_revert",
        "reverts_agent_action": true,
        "reversible": true,
        "blast_radius": "service",
        "evidence_refs": ["verification://LIVE-TEST/window"],
    }
}

test_auto_revert_of_foreign_action_denied if {
    inp := {
        "mode": "live",
        "action": "auto_revert",
        "reverts_agent_action": false,
        "reversible": true,
        "blast_radius": "service",
        "evidence_refs": ["verification://LIVE-TEST/window"],
    }
    not action.allow with input as inp
}

# --- replay-mode rules are unchanged ---------------------------------------

test_replay_rollback_rule_unchanged if {
    action.allow with input as {
        "action": "rollback",
        "posterior": 0.94,
        "evidence_refs": ["github://checkout-service/deploys/v2.14.0"],
        "deploy_recent": true,
        "upstream_outage": false,
        "observation_stagnated": false,
        "safety_envelope": {},
    }
}

test_replay_intervention_rule_unchanged if {
    action.allow with input as {
        "action": "intervention",
        "posterior": 0.6,
        "evidence_refs": ["log://demo/probe1"],
        "observation_stagnated": true,
        "safety_envelope": {"max_traffic_pct": 5, "max_duration_s": 60, "auto_revert": true},
    }
}
