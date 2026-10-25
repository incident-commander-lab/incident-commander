# Authors and contributions

Incident Commander is built by **Shahesta Salama** and **Nourseen Tarek** (Alryada University).
This file says who built which major areas. It is taken from the commit history
(`git log --diff-filter=A` on `main`: who first added each file).
Commits under `S2800-0` and "Your Name" are Shahesta's (same email). The history is kept as it is.

## Shahesta Salama

- **Replay engine.** Orchestrator, the hypothesis agents (telemetry, change, history, LLM lens),
  reasoner, value-of-information probe selection, adjudicator, incident bundles and the 12-bundle
  corpus (`ic/orchestrator.py`, `ic/agents/`, `ic/reasoner.py`, `ic/voi.py`, `ic/adjudicator.py`,
  `ic/bundle.py`, `corpus/`).
- **Evidence chain and offline verifier.** Merkle tree, Ed25519 signing, `verify.py`
  (`ic/evidence_chain.py`).
- **Policy client and the original Rego policy** (`ic/policy.py`, `policy/incident/action.rego`).
- **Telemetry ingestion and detection.** OTLP/HTTP JSON ingestion (`ic/otlp.py`), the SLO
  detector (`ic/slo_detector.py`), replay-mode verification (`ic/verification.py`).
- **Target service.** The mock checkout service and its chaos scenarios (`mock/shop_svc.py`).
- **Impact and triage.** Customer Impact Scoring, ROI model, optional LLM triage
  (`ic/cis.py`, `ic/roi.py`, `ic/dynamic_triage.py`, `ic/llm.py`).
- **Backend and console.** FastAPI server (`server/`), the console's Console and metrics views
  (`console/src/App.tsx`, `MetricsPanel.tsx`).
- **63-trial harness** (`ic/live_trials.py`), its tests and the SLO detector tests.
- **Documentation** (`docs/`), demo materials, onboarding, CI and the safety-boundary tests.

## Nourseen Tarek

- **Live mode: autonomous incident response against a running service** (one commit, 23 Sep 2026,
  `9463a5c`). The whole `ic/live/` package: telemetry store, SLO-breach detector, Bayesian beliefs
  and Shannon expected information gain, hypothesis catalog, probes, the OPA policy gate for every
  state-changing action (`governance.py`), investigator, post-action verification, target client
  and the live controller with auto-revert.
- **Live action classes in Rego** and the 14 policy tests (`policy/incident/action_test.rego`).
- **Live engine unit tests** (`tests/test_live_engine.py`), the load generator (`mock/loadgen.py`),
  the live experiment runner with baselines (`demo/live_experiment.py`) and the console's Live tab
  (`console/src/LivePanel.tsx`).

## Related research

The research that builds on this system (the AIOpsLab benchmark of the decision rule, the model
ladder, the live Pulse test bed and its pre-registered evaluation) is in the separate
`incident-commander-research` repository. There, Shahesta built the benchmark harness and test beds,
and Nourseen wrote the RQ3 evaluation protocol and session scorer, the calibration and
evidence-failure analyses, and the RQ1 evaluation and results section.
