"""The safety boundaries, tested at the seams where a bug would let the agent act unsafely:

  * the policy engine down, or answering nonsense  -> fail closed (deny), nothing executed
  * the policy engine denying an action            -> no HTTP request to the target service
  * verification failing after an action           -> the change is reverted (itself policy-gated)
  * a tampered postmortem                          -> the offline verifier fails
  * malformed or poisoned OTLP telemetry           -> rejected at the API, or dropped at ingest

The controller tests drive the real LiveController._run with a fake target service and a fake
investigation, so the path from diagnosis to policy to action to verification is the shipped one.
Run: python -m pytest tests -q
"""
from __future__ import annotations

import copy
import json
import math
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from ic import policy
from ic.evidence_chain import verify_postmortem
from ic.live import controller as C
from ic.live.catalog import LiveHypothesis
from ic.live.telemetry import TelemetryStore
from ic.live.verify import Verification
from ic.models import EvidenceItem, Hypothesis
from ic.otlp import OtlpMetricsPayload

ROOT = Path(__file__).resolve().parent.parent


# --- policy client: fail closed -----------------------------------------------------------

def test_policy_engine_unreachable_fails_closed(monkeypatch):
    monkeypatch.setattr(policy, "OPA_URL", "http://127.0.0.1:9")      # nothing listens on port 9
    monkeypatch.setattr(policy, "TIMEOUT_S", 0.5)
    d = policy.evaluate_safely({"action": "rollback_deploy"})
    assert d.allow is False and d.engine_available is False
    assert d.reasons[0] == "policy_engine_unavailable"


@pytest.mark.parametrize("reply", [{}, {"result": None}, {"result": {"reasons": []}}, {"result": "allow"}])
def test_policy_engine_answer_without_a_decision_fails_closed(monkeypatch, reply):
    monkeypatch.setattr(policy, "_http_post_json", lambda url, payload, timeout: reply)
    d = policy.evaluate_safely({"action": "rollback_deploy"})
    assert d.allow is False and d.engine_available is False


def test_policy_engine_non_json_fails_closed(monkeypatch):
    def bad(url, payload, timeout):
        raise json.JSONDecodeError("not json", "<html>", 0)
    monkeypatch.setattr(policy, "_http_post_json", bad)
    assert policy.evaluate_safely({"action": "rollback_deploy"}).allow is False


# --- controller: what reaches the target service ------------------------------------------

class FakeTarget:
    """Records every call; state changes only through execute/revert, like the real /ops API."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.version = "v6.10.0"

    def state(self):
        return {"active_version": self.version, "inventory_fallback": False}

    def execute(self, action, incident_id, reason):
        self.calls.append(("execute", action))
        self.version = "v6.9.3"
        return {"http_status": 200, "body": {"ok": True}}

    def revert(self, action, incident_id, before_state, reason):
        self.calls.append(("revert", action, before_state["active_version"]))
        self.version = before_state["active_version"]
        return {"http_status": 200, "body": {"ok": True}}


def _investigation():
    hyp = Hypothesis(id="H_deploy", claim="release v6.10.0 raised checkout errors", agent_id="test", posterior=0.97)
    leader = LiveHypothesis(hyp=hyp, kind="deploy", target="v6.10.0", remediation="rollback_deploy")
    ev = EvidenceItem(source_type="telemetry", source_uri="otlp://checkout-service/errors/by-version",
                      retrieved_at="2026-10-25T10:00:00Z", payload={"v6.10.0": 0.21, "v6.9.3": 0.01})
    now = time.time()
    return SimpleNamespace(evidence=[ev], policy_leaves=[], policy_decisions=[], next_policy_seq=0,
                           started_at=now - 2, ended_at=now, hypotheses=[leader], probes=[], actions=[],
                           entropy_trace=[0.1], stop_reason="confident", abstained=False, abstain_reason="",
                           leader=leader, confirmation="positive", deploy_recent=True,
                           posteriors={"H_deploy": 0.97})


@pytest.fixture
def run(monkeypatch, tmp_path):
    """run(opa=..., recovered=...) -> (incident record, fake target, OPA inputs seen)."""
    monkeypatch.chdir(tmp_path)                                    # signing key and results land here
    monkeypatch.setattr(C, "RESULTS_DIR", tmp_path / "live_runs")

    def _run(opa, recovered=True):
        asked = []

        def fake_opa(url, payload, timeout):
            asked.append(payload["input"]["action"])
            return opa(payload["input"])
        monkeypatch.setattr(policy, "_http_post_json", fake_opa)
        monkeypatch.setattr(C, "investigate", lambda *a, **k: _investigation())
        monkeypatch.setattr(C, "verify_recovery", lambda store, iid, at, label, slo: Verification(
            recovered=recovered, stats={"after": {}, "before": {}, "checks": []},
            evidence=EvidenceItem(source_type="verification", source_uri=f"verify://{iid}/{label}",
                                  retrieved_at="2026-10-25T10:00:10Z", payload={"recovered": recovered})))
        target = FakeTarget()
        ctl = C.LiveController(TelemetryStore(), target=target, mode="eig")
        breach = SimpleNamespace(fired_at=time.time(), value=0.2, threshold=0.05, requests=600,
                                 alert=lambda svc: {"name": "CheckoutErrors", "service": svc})
        rec = ctl.handle(breach)
        return rec, target, asked
    return _run


def _allow(inp):
    return {"result": {"allow": True, "action": inp["action"], "reasons": []}}


def test_policy_deny_means_no_request_to_the_target(run):
    rec, target, asked = run(opa=lambda inp: {"result": {"allow": False, "reasons": ["blast_radius_too_large"]}})
    assert rec["status"] == "ESCALATED_POLICY_DENIED"
    assert target.calls == [] and asked == ["rollback_deploy"]
    assert rec["remediation"]["executed"] is False and rec["remediation"]["blocked_by_policy"] is True
    assert rec["chain"]["verified"] is True                      # the denial itself is sealed


def test_policy_engine_down_means_no_request_to_the_target(run):
    def down(inp):
        raise OSError("connection refused")
    rec, target, _ = run(opa=down)
    assert rec["status"] == "ESCALATED_POLICY_ENGINE_UNAVAILABLE"
    assert target.calls == []


def test_allowed_and_verified_action_runs_once_and_is_not_reverted(run):
    rec, target, asked = run(opa=_allow, recovered=True)
    assert rec["status"] == "RESOLVED"
    assert target.calls == [("execute", "rollback_deploy")] and asked == ["rollback_deploy"]


def test_failed_verification_reverts_the_change(run):
    rec, target, asked = run(opa=_allow, recovered=False)
    assert rec["status"] == "ESCALATED_REMEDIATION_FAILED"
    assert target.calls == [("execute", "rollback_deploy"), ("revert", "rollback_deploy", "v6.10.0")]
    assert asked == ["rollback_deploy", "auto_revert"]           # the revert asked the policy engine too
    assert rec["auto_revert"] == {"executed": True, "version_after": "v6.10.0", "restored": True}


def test_revert_denied_by_policy_is_not_executed(run):
    rec, target, _ = run(opa=lambda inp: _allow(inp) if inp["action"] != "auto_revert"
                         else {"result": {"allow": False, "reasons": ["revert_not_reversible"]}}, recovered=False)
    assert target.calls == [("execute", "rollback_deploy")]
    assert rec["auto_revert"]["executed"] is False


# --- evidence chain: tampering is detected ------------------------------------------------

@pytest.fixture
def postmortem(run):
    rec, _, _ = run(opa=_allow, recovered=True)
    path = Path(rec["chain"]["postmortem"])
    return path, json.loads(path.read_text())


def test_sealed_postmortem_verifies(postmortem):
    assert verify_postmortem(postmortem[1])[0] is True


@pytest.mark.parametrize("tamper", ["evidence_payload", "verdict", "merkle_root", "signature", "drop_leaf"])
def test_tampered_postmortem_fails_verification(postmortem, tamper):
    doc = copy.deepcopy(postmortem[1])
    if tamper == "evidence_payload":
        doc["evidence"][0]["payload"]["tampered"] = True
    elif tamper == "verdict":
        doc["verdict"]["posterior"] = 0.01
    elif tamper == "merkle_root":
        doc["signing"]["merkle_root"] = "00" * 32
    elif tamper == "signature":
        sig = doc["signing"]["signature"]
        doc["signing"]["signature"] = ("0" if sig[0] != "0" else "1") + sig[1:]
    else:
        doc["evidence"] = doc["evidence"][1:]
    try:
        ok = verify_postmortem(doc)[0]
    except Exception:                                            # a malformed document must not verify either
        ok = False
    assert ok is False


def test_verify_cli_exit_codes(postmortem, tmp_path):
    path, doc = postmortem
    good = subprocess.run([sys.executable, str(ROOT / "verify.py"), str(path)], capture_output=True, text=True, cwd=ROOT)
    bad_path = tmp_path / "tampered.json"
    doc["evidence"][0]["payload"]["tampered"] = True
    bad_path.write_text(json.dumps(doc))
    bad = subprocess.run([sys.executable, str(ROOT / "verify.py"), str(bad_path)], capture_output=True, text=True, cwd=ROOT)
    assert good.returncode == 0 and "VERIFIED" in good.stdout
    assert bad.returncode == 1 and "TAMPERED" in bad.stdout


# --- telemetry: malformed payloads and poisoning ------------------------------------------

def _payload(points=None, service="checkout-service", hist=None):
    now_ns = str(int(time.time() * 1e9))
    metrics = []
    if points is not None:
        metrics.append({"name": "http.server.requests", "sum": {"dataPoints": points}})
    if hist is not None:
        metrics.append({"name": "http.server.duration", "histogram": {"dataPoints": hist}})
    resource = {"attributes": [{"key": "service.name", "value": {"stringValue": service}}]} if service else {"attributes": []}
    return OtlpMetricsPayload.model_validate(
        {"resourceMetrics": [{"resource": resource, "scopeMetrics": [{"metrics": metrics}]}]}), now_ns


def test_well_formed_points_are_stored():
    store = TelemetryStore()
    p, now_ns = _payload(points=[{"timeUnixNano": "0", "asInt": "5"}])
    p.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano = now_ns
    assert store.ingest(p) == 1 and not store.rejected


@pytest.mark.parametrize("dp,reason", [
    ({"timeUnixNano": "not-a-number", "asInt": "5"}, "unparseable"),
    ({"timeUnixNano": str(int((time.time() + 86400) * 1e9)), "asInt": "5"}, "timestamp_out_of_range"),
    ({"timeUnixNano": "0", "asInt": "5"}, "timestamp_out_of_range"),
    ({"timeUnixNano": "NOW", "asDouble": float("nan")}, "bad_value"),
    ({"timeUnixNano": "NOW", "asDouble": float("inf")}, "bad_value"),
    ({"timeUnixNano": "NOW", "asInt": "-40"}, "bad_value"),
])
def test_poisoned_sum_points_are_dropped(dp, reason):
    store = TelemetryStore()
    dp = dict(dp)
    if dp["timeUnixNano"] == "NOW":
        dp["timeUnixNano"] = str(int(time.time() * 1e9))
    p, _ = _payload(points=[dp])
    assert store.ingest(p) == 0
    assert sum(store.rejected.values()) == 1
    if reason:
        assert store.rejected[reason] == 1
    stats = store.request_stats(time.time() - 60, time.time() + 60)
    assert all(not (isinstance(v, float) and math.isnan(v)) for v in stats.values() if v is not None)


@pytest.mark.parametrize("hist", [
    {"bucketCounts": ["3", "-1", "2"], "explicitBounds": [100, 250]},          # negative count
    {"bucketCounts": ["3", "1"], "explicitBounds": [100, 250]},                # counts and bounds disagree
    {"bucketCounts": ["3", "1", "2"], "explicitBounds": [250, 100]},           # bounds out of order
    {"bucketCounts": ["3", "1", "2"], "explicitBounds": [100, 250], "sum": -5}, # negative total
])
def test_poisoned_histograms_are_dropped(hist):
    store = TelemetryStore()
    p, _ = _payload(hist=[{**hist, "timeUnixNano": str(int(time.time() * 1e9))}])
    assert store.ingest(p) == 0 and store.rejected["bad_histogram"] == 1


def test_points_without_a_service_are_dropped():
    store = TelemetryStore()
    p, now_ns = _payload(points=[{"timeUnixNano": "0", "asInt": "5"}], service=None)
    p.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano = now_ns
    assert store.ingest(p) == 0 and store.rejected["missing_service_name"] == 1


def test_one_poisoned_point_does_not_drop_the_good_ones():
    store = TelemetryStore()
    now_ns = str(int(time.time() * 1e9))
    p, _ = _payload(points=[{"timeUnixNano": now_ns, "asInt": "5"}, {"timeUnixNano": now_ns, "asDouble": float("nan")},
                            {"timeUnixNano": now_ns, "asInt": "7"}])
    assert store.ingest(p) == 2 and store.rejected["bad_value"] == 1


@pytest.mark.parametrize("body", [
    {"resourceMetrics": "nope"},
    {"resourceMetrics": [{"scopeMetrics": [{"metrics": [{"sum": {"dataPoints": []}}]}]}]},   # metric without a name
    {"resourceMetrics": [{"scopeMetrics": [{"metrics": [{"name": "x", "sum": {"dataPoints": [{"asDouble": "abc"}]}}]}]}]},
])
def test_malformed_otlp_payloads_are_rejected_by_the_schema(body):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        OtlpMetricsPayload.model_validate(body)


def test_verify_cli_rejects_a_file_that_is_not_a_sealed_postmortem(tmp_path):
    p = tmp_path / "not-sealed.json"
    p.write_text(json.dumps({"verdict": {"incident_id": "X"}, "evidence": []}))
    r = subprocess.run([sys.executable, str(ROOT / "verify.py"), str(p)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 1 and "MALFORMED" in r.stdout
