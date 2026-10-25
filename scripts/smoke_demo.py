#!/usr/bin/env python3
"""Headless end-to-end smoke test: clean clone -> the demo works.

    python scripts/smoke_demo.py          # needs OPA on :8181, or Docker to start it

Starts the target service (mock shop-svc, :9001) and the backend (:8000), drives 60 rps of
traffic, then runs two of the console's scenarios and checks the outcome the README promises:

  1. bad_deploy           -> rollback executed, recovery verified (RESOLVED), postmortem
                             verifies offline, and a tampered copy fails verification
  2. database_saturation  -> failover proposed, OPA denies it, nothing executed

Exit 0 when both hold. The same script runs in CI (.github/workflows/ci.yml). It leaves no
processes behind; OPA is left running only if it was already running before.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND, TARGET, OPA = "http://127.0.0.1:8000", "http://127.0.0.1:9001", "http://127.0.0.1:8181"
TIMEOUT_S = float(os.environ.get("SMOKE_TIMEOUT_S", "150"))


def http(method: str, url: str, timeout: float = 5.0):
    req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def wait_for(url: str, what: str, timeout: float = 60.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            http("GET", url, timeout=2)
            return
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.5)
    raise SystemExit(f"FAIL: {what} did not come up at {url} within {timeout:.0f}s")


def ensure_opa() -> bool:
    """True if this script started OPA (and should stop it)."""
    try:
        http("GET", f"{OPA}/health")
        print("OPA already running on :8181")
        return False
    except (urllib.error.URLError, OSError):
        pass
    if not shutil.which("docker"):
        raise SystemExit("FAIL: OPA is not running on :8181 and Docker is not installed (see README Quickstart)")
    print("starting OPA (docker compose up -d opa)")
    subprocess.run(["docker", "compose", "up", "-d", "opa"], cwd=ROOT, check=True)
    wait_for(f"{OPA}/health", "OPA", timeout=90)
    return True


def wait_incident(seen: set[str], timeout: float) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        for rec in http("GET", f"{BACKEND}/live/incidents"):
            if rec["incident_id"] not in seen:
                return rec
        time.sleep(1)
    raise SystemExit(f"FAIL: no incident closed within {timeout:.0f}s")


def wait_rearmed(timeout: float = 60.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        s = http("GET", f"{BACKEND}/live/state")
        if not s.get("investigating") and s.get("armed"):
            return
        time.sleep(1)
    raise SystemExit("FAIL: detector did not re-arm after the first incident")


def main() -> int:
    sys.path.insert(0, str(ROOT))
    from ic.evidence_chain import verify_postmortem

    started_opa = ensure_opa()
    results = tempfile.mkdtemp(prefix="ic-smoke-")
    env = {**os.environ, "IC_LIVE_RESULTS_DIR": results, "PYTHONUNBUFFERED": "1"}
    procs = [subprocess.Popen([sys.executable, "-m", "uvicorn", mod, "--port", port, "--log-level", "warning"],
                              cwd=ROOT, env=env)
             for mod, port in (("mock.shop_svc:app", "9001"), ("server.app:app", "8000"))]
    failures: list[str] = []
    try:
        wait_for(f"{TARGET}/chaos/state", "target service")
        wait_for(f"{BACKEND}/live/state", "backend")
        http("POST", f"{TARGET}/loadgen/start?rps=60")
        print("traffic on (60 rps); 15 s of healthy baseline")
        time.sleep(15)
        seen = {r["incident_id"] for r in http("GET", f"{BACKEND}/live/incidents")}

        print("scenario 1: bad_deploy (expect rollback -> verified recovery)")
        http("POST", f"{TARGET}/chaos/scenario/bad_deploy")
        rec = wait_incident(seen, TIMEOUT_S)
        seen.add(rec["incident_id"])
        print(f"  {rec['incident_id']}: {rec['status']}, remediation={(rec.get('remediation') or {}).get('action')}")
        if rec["status"] != "RESOLVED":
            failures.append(f"bad_deploy ended {rec['status']}, expected RESOLVED")
        doc = http("GET", f"{BACKEND}/live/incidents/{rec['incident_id']}/postmortem")
        ok, _ = verify_postmortem(doc)
        bad = copy.deepcopy(doc)
        bad["evidence"][0]["payload"] = {**bad["evidence"][0].get("payload", {}), "tampered": True}
        tampered_ok, _ = verify_postmortem(bad)
        print(f"  postmortem verifies: {ok}; tampered copy verifies: {tampered_ok}")
        if not ok:
            failures.append("sealed postmortem did not verify")
        if tampered_ok:
            failures.append("tampered postmortem still verified")

        http("POST", f"{TARGET}/chaos/clear")
        wait_rearmed()

        print("scenario 2: database_saturation (expect failover proposed -> OPA deny -> nothing executed)")
        http("POST", f"{TARGET}/chaos/scenario/database_saturation")
        rec = wait_incident(seen, TIMEOUT_S)
        rem = rec.get("remediation") or {}
        print(f"  {rec['incident_id']}: {rec['status']}, proposed={rem.get('action')}, executed={rem.get('executed')}")
        if rec["status"] != "ESCALATED_POLICY_DENIED" or rem.get("executed"):
            failures.append(f"database_saturation ended {rec['status']} (executed={rem.get('executed')}), "
                            "expected ESCALATED_POLICY_DENIED with nothing executed")
        http("POST", f"{TARGET}/chaos/clear")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        if started_opa:
            subprocess.run(["docker", "compose", "stop", "opa"], cwd=ROOT, check=False, capture_output=True)
        shutil.rmtree(results, ignore_errors=True)

    if failures:
        print("SMOKE TEST FAILED:\n  - " + "\n  - ".join(failures))
        return 1
    print("SMOKE TEST PASSED: verified rollback, sealed and verifiable postmortem, tamper detected, policy deny")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
