"""FastAPI + WebSocket server. Streams orchestrator events to the console.

Run:  uvicorn server.app:app --reload --port 8000

The event stream can be served live (runs the orchestrator) or from a recorded replay
(`replays/INC-XXXX.json`) so a live LLM hiccup can never break a stage demo. Events are
paced with deliberate beats on the ambiguity/probe moments — that is the wow.
"""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ic.bundle import load_bundle, load_corpus
from ic.harness import main as run_harness
from ic.orchestrator import run_investigation
from ic.otlp import (OtlpLogsPayload, OtlpMetricsPayload, logs_to_evidence,
                     metrics_to_evidence)
from ic.live.controller import RESULTS_DIR as LIVE_RESULTS_DIR
from ic.live.controller import LiveController
from ic.live.telemetry import TelemetryStore
from ic.policy import OPA_URL, build_input_for_intervention, evaluate_safely

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
REPLAY_DIR = ROOT / "replays"

# --- live mode ---------------------------------------------------------------
# The controller runs on its own thread from startup. It stays idle until OTLP
# telemetry arrives and an SLO breaches, so replay-only use is unaffected.
# IC_LIVE=0 disables it entirely.
live_store = TelemetryStore()
live = LiveController(live_store)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("IC_LIVE", "1") != "0":
        live.start()
    yield
    live.stop()


app = FastAPI(title="Incident Commander", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Deliberate pacing (seconds) per event type — the probe beat is the theatre.
PACE = {
    "agent_started": 0.25, "agent_reasoned": 0.35, "hypothesis_proposed": 0.5,
    "ambiguity_detected": 1.3, "probe_selected": 1.1, "probe_result": 0.9,
    "posterior_updated": 0.5, "hypothesis_eliminated": 0.8, "exhausted": 0.8,
    "gate_pending": 0.7, "verdict": 0.6, "chain_sealed": 0.6,
    # Newly-shipped events — deliberate beats so the console has time to render.
    "policy_decision": 0.7, "action_blocked": 0.8,
    "verification_started": 0.4, "verification_result": 0.9,
    "auto_revert_triggered": 0.9,
    "customer_impact_computed": 0.6,
    "dynamic_generation_started": 0.3, "hypothesis_generated": 0.4,
    "dynamic_generation_completed": 0.4, "dynamic_generation_fallback": 0.5,
    # Real rollback execution against the target service.
    "rollback_execution_started": 0.7, "rollback_executed": 1.2,
    "rollback_execution_failed": 0.9,
}


@app.get("/incidents")
def incidents():
    out = []
    for b in load_corpus(CORPUS):
        out.append({"incident_id": b.incident_id, "slice": b.slice, "title": b.title,
                    "alert": b.alert, "ground_truth": b.ground_truth,
                    "has_replay": (REPLAY_DIR / f"{b.incident_id}.json").exists()})
    return out


@app.get("/policy/health")
def policy_health():
    """Is the OPA sidecar actually reachable?

    The console defaults its `policy` toggle to this. Why it matters: with the
    toggle on and OPA down, `evaluate_safely` fails closed (correctly) and the
    intervention is blocked — so a demo machine without `docker compose up opa`
    shows a *safe but wrong* verdict (H1 @ 57% instead of H2 @ 94% on INC-4478).
    Detecting the engine beats hardcoding either default: policy-gated when the
    stack is up, plain human-gated when it isn't.
    """
    probe = build_input_for_intervention(
        incident_id="INC-HEALTHCHECK",
        posterior=0.6,
        evidence_refs=["healthcheck://opa"],
        safety_envelope={"max_traffic_pct": 5, "max_duration_s": 60, "auto_revert": True},
        observation_stagnated=True,
    )
    decision = evaluate_safely(probe)
    return {"available": decision.engine_available,
            "url": OPA_URL,
            "detail": "" if decision.engine_available else "; ".join(decision.reasons)}


@app.get("/harness")
def harness():
    path = ROOT / "harness_results.json"
    if not path.exists():
        run_harness(str(CORPUS), str(path))
    return JSONResponse(json.loads(path.read_text()))


# ---------------------------------------------------------------------------
# OTLP ingestion endpoints — real OpenTelemetry HTTP JSON receivers.
#
# In production these sit behind an OTel Collector that batches metrics/logs
# from your applications. For the demo, NiFi (or a `curl` from the corpus
# bridge in `demo/otlp_bridge.py`) posts spec-compliant OTLP JSON here. Every
# accepted batch is converted to typed `EvidenceItem`s and appended to
# `_ingest_buffer` so a subsequent /investigate can consume them as the prior
# evidence for an incident.
#
# Buffer is deliberately in-memory for now — Cassandra persistence lands with
# the evidence-chain durability piece later this week.
# ---------------------------------------------------------------------------

_ingest_buffer: list[dict] = []
_INGEST_CAP = 5000  # bounded to avoid unbounded growth from a mis-configured feed


def _remember(items: list) -> None:
    for it in items:
        _ingest_buffer.append(it.model_dump(mode="json"))
    while len(_ingest_buffer) > _INGEST_CAP:
        _ingest_buffer.pop(0)


@app.post("/ingest/otlp/v1/metrics")
def ingest_otlp_metrics(payload: OtlpMetricsPayload) -> dict:
    stored = live_store.ingest(payload)  # live mode reads telemetry from here; malformed points are dropped
    items = metrics_to_evidence(payload)
    _remember(items)
    return {"accepted": len(items), "stored_points": stored, "rejected_points": dict(live_store.rejected),
            "kinds": sorted({it.payload.get("metric.kind", "") for it in items}),
            "sources": sorted({it.source_uri for it in items})[:16]}


@app.post("/ingest/otlp/v1/logs")
def ingest_otlp_logs(payload: OtlpLogsPayload) -> dict:
    items = logs_to_evidence(payload)
    _remember(items)
    return {"accepted": len(items),
            "records": sum(it.payload.get("record_count", 0) for it in items),
            "sources": sorted({it.source_uri for it in items})[:16]}


@app.get("/ingest/otlp/buffer")
def ingest_buffer(limit: int = 50) -> dict:
    """Peek at recent items — helps the demo prove ingestion is real."""
    items = _ingest_buffer[-max(0, min(limit, len(_ingest_buffer))):]
    return {"size": len(_ingest_buffer), "returned": len(items), "items": items}


@app.post("/investigate")
def investigate(body: dict):
    """Non-streaming: run and return the full result (handy for tests)."""
    b = load_bundle(CORPUS / f"{body['incident_id']}.json")
    res = run_investigation(b, probes_enabled=body.get("probes_enabled", True))
    return {"verdict": res.verdict.model_dump(), "events": res.events,
            "probes_run": res.probes_run}


def _events_for(incident_id: str, probes_enabled: bool, replay: bool,
                 policy_enabled: bool = False,
                 execute_rollback: bool = False) -> list[dict]:
    # Live path re-runs the orchestrator so newly-shipped events
    # (policy_decision, verification_result, customer_impact_computed,
    # hypothesis_generated, auto_revert_triggered, rollback_executed)
    # reach the console. Replay path returns pre-recorded events (kept as a
    # demo-safety net).
    if replay:
        p = REPLAY_DIR / f"{incident_id}.json"
        if p.exists():
            return json.loads(p.read_text())
    b = load_bundle(CORPUS / f"{incident_id}.json")
    return run_investigation(b, probes_enabled=probes_enabled,
                              policy_enabled=policy_enabled,
                              execute_rollback=execute_rollback).events


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    try:
        params = await sock.receive_json()
        events = _events_for(params["incident_id"],
                             params.get("probes_enabled", True),
                             params.get("replay", False),
                             params.get("policy_enabled", False),
                             params.get("execute_rollback", False))
        speed = float(params.get("speed", 1.0))
        for e in events:
            await sock.send_json(e)
            await asyncio.sleep(PACE.get(e["type"], 0.4) / max(speed, 0.1))
        await sock.send_json({"type": "done"})
    except WebSocketDisconnect:
        return


def record_replays() -> None:
    REPLAY_DIR.mkdir(exist_ok=True)
    for b in load_corpus(CORPUS):
        res = run_investigation(b, probes_enabled=True, use_llm=False)  # stable replays
        (REPLAY_DIR / f"{b.incident_id}.json").write_text(json.dumps(res.events, indent=2))
        print(f"recorded {b.incident_id}: {len(res.events)} events")


if __name__ == "__main__":
    record_replays()


# ---------------------------------------------------------------------------
# LIVE MODE — read-only views of what the autonomous controller is doing.
# There is deliberately no endpoint to start an investigation, run a probe or
# approve an action: incidents open from telemetry and OPA decides actions.
# ---------------------------------------------------------------------------

@app.get("/live/state")
def live_state() -> dict:
    return live.snapshot()


@app.get("/live/events")
def live_events(since: int = 0, limit: int = 500) -> dict:
    events = live.events_since(since, min(limit, 2000))
    return {"events": events, "last_seq": events[-1]["seq"] if events else since}


@app.get("/live/incidents")
def live_incidents() -> list[dict]:
    return live.incidents


@app.get("/live/incidents/{incident_id}/postmortem")
def live_postmortem(incident_id: str) -> JSONResponse:
    path = LIVE_RESULTS_DIR / f"{incident_id}.postmortem.json"
    if not path.exists():
        raise HTTPException(404, "no sealed postmortem for that incident")
    return JSONResponse(json.loads(path.read_text()))


@app.post("/live/mode")
def live_mode(body: dict) -> dict:
    """Selects the investigation policy used for the NEXT incident — a
    measurement switch for baselines, not a way to steer an investigation."""
    try:
        live.set_mode(body.get("mode", ""))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"mode": live.mode}


# ============================================================================
# Demo helper — runs `python -m ic.live_trials` as a subprocess and streams
# stdout back to the console so the judge can watch the 63-trial harness
# run without leaving the browser. This is purely UI convenience — the
# harness itself is the source of truth (ic/live_trials.py).
# ============================================================================
import subprocess as _subprocess
import sys as _sys
from pathlib import Path as _Path

@app.post("/demo/run_trials")
def demo_run_trials() -> dict:
    """Execute the 63-trial harness once, return stdout as a single string."""
    repo = _Path(__file__).resolve().parent.parent
    try:
        r = _subprocess.run(
            [_sys.executable, "-m", "ic.live_trials"],
            cwd=str(repo), capture_output=True, text=True, timeout=60,
        )
        return {
            "ok": r.returncode == 0,
            "returncode": r.returncode,
            "stdout": r.stdout,
            "stderr": r.stderr[-2000:] if r.stderr else "",
        }
    except _subprocess.TimeoutExpired:
        return {"ok": False, "returncode": -1, "stdout": "", "stderr": "timeout after 60s"}
    except Exception as e:
        return {"ok": False, "returncode": -1, "stdout": "", "stderr": str(e)}
