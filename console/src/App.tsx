import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, EvidenceLeaf, Hypothesis, ICEvent, Incident } from "./types";
import MetricsPanel from "./MetricsPanel";
import LivePanel from "./LivePanel";

type LaneLine = { t: number; text: string; kind: string; hyp?: string };
type Ambiguity = { margin: number; tau: number; reason?: string; resolvable: boolean; note?: string } | null;
type ProbeSel = { probe_id: string; info_gain: number; cost_ms: number; description: string } | null;
type ProbeRes = { probe_id: string; summary: string; hash: string; source_uri: string } | null;
type Sealed = { merkle_root: string; signature: string; leaf_count: number } | null;
type Verdict = { root_cause_id: string; summary: string; posterior: number; rollback_recommended: boolean; probes_run: string[] } | null;
type VoiAction = { action_id: string; kind: string; eig: number; cost: number; risk: number; voi_score: number; executable: boolean; description?: string };
type VoiState = { step: number; actions: VoiAction[] } | null;
type Stagnation = { best_observation: string | null; best_observation_eig: number; intervention_eig: number | null; intervention_available?: boolean } | null;
type GatePending = { action: string; intervention_id?: string; description?: string; safety_envelope?: any; note?: string } | null;
type InterventionResult = { intervention_id: string; summary: string; hash: string } | null;

// Shipped-in-final-pivot event types — surfaced in the new panels.
type PolicyDecisionEvt = { action: string; allow: boolean; reasons: string[]; engine_available: boolean; thresholds?: any; intervention_id?: string; description?: string; note?: string };
type VerificationEvt = { intervention_id?: string; recovered: boolean; signal?: string; baseline_value?: number | null; post_intervention_value?: number | null; recovery_band?: any; reasoning?: string; source_uri?: string; synthesised?: boolean };
type AutoRevertEvt = { intervention_id?: string; reason: string; safety_envelope?: any };
type CustomerImpactEvt = { tier?: string | null; affected_users: number; sla_breach: boolean; revenue_tagged_service: boolean; impact_source: string; cis_score: number; components?: Record<string, number> };
type DynamicMetaEvt = { count?: number; reasoning_summary?: string; mode?: string; reason?: string; note?: string };
type DynamicHypEvt = { id: string; claim: string; confidence: number; natural_owner?: string; supporting_evidence: string[]; contradicting_evidence: string[]; discriminating_signals: string[] };
type ActionBlockedEvt = { action: string; intervention_id?: string; reasons: string[]; engine_available: boolean; note?: string };
// Real rollback execution against the mock target service.
type TargetServiceState = { version: string; error_rate: number; p95_ms: number; since: number; reason: string };
type RollbackExecEvt = { target: string; target_state?: TargetServiceState; summary?: string; error?: string; note?: string; kind: "started" | "executed" | "failed" };

const AGENT_LABEL: Record<string, string> = {
  change_agent: "Change",
  telemetry_agent: "Telemetry",
  history_agent: "History",
};
const AGENT_ROLE: Record<string, string> = {
  change_agent: "deploy-biased",
  telemetry_agent: "signal-biased",
  history_agent: "pattern-biased",
};

// ---- Inline SVG icons for the rail ----
const IconInvestigations = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h4l2-6 4 12 2-6h6" /></svg>
);
const IconAblation = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="20" x2="4" y2="10" /><line x1="10" y1="20" x2="10" y2="4" /><line x1="16" y1="20" x2="16" y2="14" /><line x1="22" y1="20" x2="22" y2="7" /></svg>
);
const IconBundles = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>
);
const IconVerify = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>
);
const IconBell = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
);
const IconHelp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
);
// Distinctive brand mark — a target reticle. Not letters.
const BrandMark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><line x1="12" y1="1" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="23" /><line x1="1" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="23" y2="12" />
  </svg>
);
const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="7,4 20,12 7,20" /></svg>
);
const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);

type PanelKind = null | "bundles" | "verify" | "docs" | "about" | "alerts" | "user";

export default function App() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [sel, setSel] = useState<string>("INC-4471");
  const [probesOn, setProbesOn] = useState(true);
  const [replay, setReplay] = useState(false);          // live path by default, replays are backup
  const [policyOn, setPolicyOn] = useState(true);       // NoOps mode — OPA gate, verification, CIS
  // null = still probing. Drives the default of `policyOn`: see the effect below.
  const [opaUp, setOpaUp] = useState<boolean | null>(null);
  // Live mode is the default view; `?auto=` (the replay screenshot renderer) keeps the replay console.
  const [tab, setTab] = useState<"live" | "console" | "metrics">(
    () => (new URLSearchParams(window.location.search).get("auto") ? "console" : "live"));
  const [running, setRunning] = useState(false);

  const [lanes, setLanes] = useState<Record<string, LaneLine[]>>({});
  const [hyps, setHyps] = useState<Record<string, Hypothesis>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [ambiguity, setAmbiguity] = useState<Ambiguity>(null);
  const [probeSel, setProbeSel] = useState<ProbeSel>(null);
  const [probeRes, setProbeRes] = useState<ProbeRes>(null);
  const [exhausted, setExhausted] = useState<any>(null);
  const [leaves, setLeaves] = useState<EvidenceLeaf[]>([]);
  const [sealed, setSealed] = useState<Sealed>(null);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [gate, setGate] = useState<any>(null);
  const [voi, setVoi] = useState<VoiState>(null);
  const [stagnation, setStagnation] = useState<Stagnation>(null);
  const [interventionWouldFire, setInterventionWouldFire] = useState<any>(null);
  const [provenance, setProvenance] = useState<string | null>(null);
  const [interventionGate, setInterventionGate] = useState<GatePending>(null);
  const [interventionApproved, setInterventionApproved] = useState(false);
  const [interventionResult, setInterventionResult] = useState<InterventionResult>(null);
  // ---- Newly-shipped state ----
  const [policyDecisions, setPolicyDecisions] = useState<PolicyDecisionEvt[]>([]);
  const [verification, setVerification] = useState<VerificationEvt | null>(null);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [autoRevert, setAutoRevert] = useState<AutoRevertEvt | null>(null);
  const [customerImpact, setCustomerImpact] = useState<CustomerImpactEvt | null>(null);
  const [dynamicMeta, setDynamicMeta] = useState<DynamicMetaEvt | null>(null);
  const [dynamicHyps, setDynamicHyps] = useState<Record<string, DynamicHypEvt>>({});
  const [actionBlocked, setActionBlocked] = useState<ActionBlockedEvt | null>(null);
  // Target-service (real HTTP execution) — pre-rollback state + rollback events.
  const [executeRollback, setExecuteRollback] = useState<boolean>(true);
  const [targetPre, setTargetPre] = useState<TargetServiceState | null>(null);
  const [targetPost, setTargetPost] = useState<TargetServiceState | null>(null);
  const [rollbackExec, setRollbackExec] = useState<RollbackExecEvt | null>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [query, setQuery] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const startRef = useRef<number>(0);
  const gatePausedRef = useRef<boolean>(false);
  const queuedRef = useRef<ICEvent[]>([]);

  useEffect(() => {
    fetch("/incidents").then((r) => r.json()).then(setIncidents).catch(() => {});
  }, []);

  // ---- Default the policy gate to whether OPA is actually reachable ----
  // With `policy` on and OPA down, the gate fails closed (by design) and the
  // intervention never runs — so a machine without `docker compose up opa`
  // shows a safe but WRONG verdict (INC-4478 lands H1 @ 57%, not H2 @ 94%).
  // Probing beats hardcoding either default: policy-gated when the stack is
  // up, human-gated when it isn't.
  //
  // Deliberately skipped when the URL drives the run (`?auto=` / `&policy=`):
  // the screenshot renderer must stay deterministic, and an async probe
  // resolving mid-run would flip the toggle underneath it.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("auto") || q.get("policy") !== null) return;
    fetch("/policy/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        if (!h) return;
        setOpaUp(!!h.available);
        setPolicyOn(!!h.available);
      })
      .catch(() => {});
  }, []);

  // ---- URL-based auto-start (for headless screenshots) ----
  // Usage: /?auto=INC-4478  (auto-clicks Investigate on load; skip replay)
  // Optional: &policy=0 to turn OPA gate off, &probes=0 to run the OFF arm.
  useEffect(() => {
    if (!incidents.length) return;
    const q = new URLSearchParams(window.location.search);
    const auto = q.get("auto");
    if (!auto) return;
    if (!incidents.find((i) => i.incident_id === auto)) return;
    setSel(auto);
    if (q.get("policy") === "0") setPolicyOn(false);
    if (q.get("probes") === "0") setProbesOn(false);
    if (q.get("execute") === "0") setExecuteRollback(false);
    setReplay(false);
    const t = setTimeout(() => {
      // schedule after state settles so `sel` change flushes
      const btn = document.querySelector<HTMLButtonElement>(".btnInvestigate");
      btn?.click();
    }, 300);
    return () => clearTimeout(t);
  }, [incidents]);

  const incident = incidents.find((i) => i.incident_id === sel);
  const filteredIncidents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return incidents;
    return incidents.filter(
      (i) => i.incident_id.toLowerCase().includes(q) || i.slice.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
    );
  }, [incidents, query]);

  function reset() {
    setLanes({}); setHyps({}); setOrder([]); setAmbiguity(null);
    setProbeSel(null); setProbeRes(null); setExhausted(null);
    setLeaves([]); setSealed(null); setVerdict(null); setGate(null);
    setVoi(null); setStagnation(null); setInterventionWouldFire(null); setProvenance(null);
    setInterventionGate(null); setInterventionApproved(false); setInterventionResult(null);
    setPolicyDecisions([]); setVerification(null); setVerifying(false);
    setAutoRevert(null); setCustomerImpact(null); setDynamicMeta(null);
    setDynamicHyps({}); setActionBlocked(null);
    setTargetPre(null); setTargetPost(null); setRollbackExec(null);
    gatePausedRef.current = false;
    queuedRef.current = [];
  }

  function addLeaf(uri: string, hash?: string, probe?: boolean, intervention?: boolean) {
    setLeaves((prev) => {
      const existing = prev.find((l) => l.uri === uri);
      if (existing) {
        if (hash && !existing.hash) return prev.map((l) => (l.uri === uri ? { ...l, hash, probe, intervention } : l));
        return prev;
      }
      return [...prev, { uri, hash: hash || "", probe: !!probe, intervention: !!intervention }];
    });
  }

  function handle(e: ICEvent) {
    const t = Math.round(performance.now() - startRef.current);
    switch (e.type) {
      case "agent_started":
        setLanes((p) => ({ ...p, [e.agent_id]: p[e.agent_id] || [] }));
        break;
      case "agent_reasoned": {
        const line: LaneLine = {
          t, kind: "reason",
          text: `${e.hyp_id}  ${e.delta >= 0 ? "+" : ""}${e.delta}  ${e.rationale}`,
          hyp: e.hyp_id,
        };
        setLanes((p) => ({ ...p, [e.agent_id]: [...(p[e.agent_id] || []), line] }));
        (e.evidence_refs || []).forEach((r: string) => addLeaf(r));
        break;
      }
      case "hypothesis_proposed":
        setHyps((p) => ({
          ...p,
          [e.id]: { id: e.id, claim: e.claim, agent_id: e.agent_id, posterior: e.posterior, eliminated: false, evidence_refs: e.evidence_refs || [] },
        }));
        setOrder((o) => (o.includes(e.id) ? o : [...o, e.id]));
        (e.evidence_refs || []).forEach((r: string) => addLeaf(r));
        break;
      case "posterior_updated":
        setHyps((p) => ({ ...p, [e.id]: { ...p[e.id], posterior: e.posterior } }));
        break;
      case "hypothesis_eliminated":
        setHyps((p) => ({ ...p, [e.id]: { ...p[e.id], eliminated: true, eliminated_reason: e.reason } }));
        break;
      case "ambiguity_detected":
        setAmbiguity({ margin: e.margin, tau: e.tau, reason: e.reason, resolvable: e.resolvable, note: e.note });
        break;
      case "probe_selected":
        setProbeSel({ probe_id: e.probe_id, info_gain: e.info_gain, cost_ms: e.cost_ms, description: e.description });
        break;
      case "probe_result":
        setProbeRes({ probe_id: e.probe_id, summary: e.summary, hash: e.hash, source_uri: e.source_uri });
        addLeaf(e.source_uri, e.hash, true);
        break;
      case "exhausted":
        setExhausted(e);
        break;
      case "voi_scored":
        setVoi({ step: e.step, actions: e.actions });
        break;
      case "voi_stagnation_detected":
        setStagnation({ best_observation: e.best_observation, best_observation_eig: e.best_observation_eig, intervention_eig: e.intervention_eig, intervention_available: e.intervention_available });
        break;
      case "intervention_would_fire":
        setInterventionWouldFire(e);
        break;
      case "provenance_labeled":
        setProvenance(e.provenance);
        break;
      case "gate_pending":
        if (e.action === "intervention") {
          setInterventionGate({ action: e.action, intervention_id: e.intervention_id, description: e.description, safety_envelope: e.safety_envelope, note: e.note });
          gatePausedRef.current = true;
        } else {
          setGate(e);
        }
        break;
      case "intervention_executed":
        setInterventionResult({ intervention_id: e.intervention_id, summary: e.summary, hash: e.hash });
        addLeaf(e.source_uri, e.hash, false, true);
        break;
      case "verdict":
        setVerdict({
          root_cause_id: e.root_cause_id, summary: e.summary,
          posterior: e.posterior, rollback_recommended: e.rollback_recommended,
          probes_run: e.probes_run,
        });
        break;
      case "chain_sealed":
        setSealed({ merkle_root: e.merkle_root, signature: e.signature, leaf_count: e.leaf_count });
        break;
      // ---- Newly-shipped events ----
      case "policy_decision":
        setPolicyDecisions((prev) => [...prev, {
          action: e.action, allow: e.allow, reasons: e.reasons || [],
          engine_available: e.engine_available, thresholds: e.thresholds,
          intervention_id: e.intervention_id, description: e.description, note: e.note,
        }]);
        break;
      case "action_blocked":
        setActionBlocked({
          action: e.action, intervention_id: e.intervention_id,
          reasons: e.reasons || [], engine_available: e.engine_available, note: e.note,
        });
        break;
      case "verification_started":
        setVerifying(true);
        break;
      case "verification_result":
        setVerifying(false);
        setVerification({
          intervention_id: e.intervention_id, recovered: e.recovered, signal: e.signal,
          baseline_value: e.baseline_value, post_intervention_value: e.post_intervention_value,
          recovery_band: e.recovery_band, reasoning: e.reasoning,
          source_uri: e.source_uri, synthesised: e.synthesised,
        });
        break;
      case "auto_revert_triggered":
        setAutoRevert({
          intervention_id: e.intervention_id, reason: e.reason,
          safety_envelope: e.safety_envelope,
        });
        break;
      case "customer_impact_computed":
        setCustomerImpact({
          tier: e.tier, affected_users: e.affected_users, sla_breach: e.sla_breach,
          revenue_tagged_service: e.revenue_tagged_service, impact_source: e.impact_source,
          cis_score: e.cis_score, components: e.components,
        });
        break;
      case "hypothesis_generated":
        setDynamicHyps((prev) => ({ ...prev, [e.id]: {
          id: e.id, claim: e.claim, confidence: e.confidence,
          natural_owner: e.natural_owner,
          supporting_evidence: e.supporting_evidence || [],
          contradicting_evidence: e.contradicting_evidence || [],
          discriminating_signals: e.discriminating_signals || [],
        }}));
        break;
      case "dynamic_generation_started":
        setDynamicMeta({ mode: "dynamic", note: "generating hypotheses from raw context…" });
        break;
      case "dynamic_generation_completed":
        setDynamicMeta((prev) => ({ ...(prev || {}), mode: "dynamic",
          count: e.count, reasoning_summary: e.reasoning_summary }));
        break;
      case "dynamic_generation_fallback":
        setDynamicMeta({ mode: "fallback", reason: e.reason, note: e.note });
        break;
      // ---- Real rollback execution (Sep 22) — target service reacts ----
      case "rollback_execution_started":
        setRollbackExec({ kind: "started", target: e.target, note: e.note });
        break;
      case "rollback_executed":
        setRollbackExec({ kind: "executed", target: e.target, target_state: e.target_state, summary: e.summary });
        setTargetPost(e.target_state);
        break;
      case "rollback_execution_failed":
        setRollbackExec({ kind: "failed", target: e.target, error: e.error, note: e.note });
        break;
      case "done":
        setRunning(false);
        break;
    }
  }

  function dispatch(e: ICEvent) {
    if (gatePausedRef.current && e.type !== "gate_pending") {
      queuedRef.current.push(e);
      return;
    }
    handle(e);
  }

  function approveIntervention() {
    gatePausedRef.current = false;
    setInterventionApproved(true);
    const queued = queuedRef.current;
    queuedRef.current = [];
    queued.forEach((e, i) => setTimeout(() => handle(e), i * 320));
  }

  function start() {
    if (wsRef.current) wsRef.current.close();
    reset();
    setRunning(true);
    startRef.current = performance.now();
    // Prime the target-service panel with the "before" snapshot. Uses the
    // vite proxy on same origin.
    fetch("/api/shop/health").then((r) => (r.ok ? r.json() : null)).then((s) => s && setTargetPre(s)).catch(() => {});
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    const q = new URLSearchParams(window.location.search);
    const speed = parseFloat(q.get("speed") || "1") || 1;
    ws.onopen = () => ws.send(JSON.stringify({
      incident_id: sel,
      probes_enabled: probesOn, replay,
      policy_enabled: policyOn,
      execute_rollback: executeRollback,
      speed,
    }));
    ws.onmessage = (m) => dispatch(JSON.parse(m.data));
    ws.onclose = () => setRunning(false);
  }

  const ranked = useMemo(
    () => order.map((id) => hyps[id]).filter(Boolean).sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.posterior - a.posterior),
    [order, hyps]
  );

  return (
    <div className="app">
      {/* ==================== LEFT RAIL ==================== */}
      <aside className="rail">
        <div className="railLogo"><BrandMark /></div>
        <button className={`railBtn ${tab === "console" ? "on" : ""}`} onClick={() => setTab("console")}>
          <IconInvestigations />
          <span className="railTip">Investigations</span>
        </button>
        <button className={`railBtn ${tab === "metrics" ? "on" : ""}`} onClick={() => setTab("metrics")}>
          <IconAblation />
          <span className="railTip">Ablation &amp; Calibration</span>
        </button>
        <button className={`railBtn ${panel === "bundles" ? "on" : ""}`} onClick={() => setPanel(panel === "bundles" ? null : "bundles")}>
          <IconBundles />
          <span className="railTip">Incident Bundles</span>
        </button>
        <button className={`railBtn ${panel === "verify" ? "on" : ""}`} onClick={() => setPanel(panel === "verify" ? null : "verify")}>
          <IconVerify />
          <span className="railTip">Offline Verifier</span>
        </button>
        <div className="railSpacer" />
        <button className={`railBtn ${panel === "docs" ? "on" : ""}`} onClick={() => setPanel(panel === "docs" ? null : "docs")}>
          <IconHelp />
          <span className="railTip">Documentation</span>
        </button>
      </aside>

      {/* ==================== WORKSPACE ==================== */}
      <div className="workspace">
        {/* Top header */}
        <header className="topbar">
          <div className="brand">
            <span className="brandMark"><BrandMark /></span>
            <span className="brandName">Incident Commander</span>
            <span className="brandDivider">|</span>
            <span className="appName">VoI Investigation Console</span>
          </div>
          <div className="topSpacer" />
          <div className="topActions">
            <input
              type="search" className="topSearch" placeholder="Search incidents by id, slice, or title…"
              value={query} onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setPanel("bundles")}
            />
            <button className="topIcon" title="Notifications" onClick={() => setPanel(panel === "alerts" ? null : "alerts")}>
              <IconBell />
              <span className="topBadge">3</span>
            </button>
            <div className="avatar" title="Signed in" onClick={() => setPanel(panel === "user" ? null : "user")} style={{ cursor: "pointer" }}>S</div>
          </div>
        </header>

        {/* Tabs */}
        <nav className="tabs">
          <button className={`tab ${tab === "live" ? "on" : ""}`} onClick={() => setTab("live")}>Live</button>
          <button className={`tab ${tab === "console" ? "on" : ""}`} onClick={() => setTab("console")}>Replay Console</button>
          <button className={`tab ${tab === "metrics" ? "on" : ""}`} onClick={() => setTab("metrics")}>Ablation &amp; Calibration</button>
        </nav>

        {/* Breadcrumb */}
        <div className="breadcrumb">
          <span>Home</span>
          <span className="crumbSep">/</span>
          <span>{tab === "metrics" ? "Ablation" : tab === "live" ? "Live · checkout-service" : "Replay investigations"}</span>
          {tab === "console" && (
            <>
              <span className="crumbSep">/</span>
              <b>{sel}</b>
              {incident && <span className="crumbSlice">{incident.slice}</span>}
            </>
          )}
        </div>

        {/* Content */}
        <main className="content">
          {tab === "live" ? <LivePanel /> : tab === "metrics" ? <MetricsPanel /> : (
            <>
              <div className="controls">
                <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={running}>
                  {incidents.map((i) => (
                    <option key={i.incident_id} value={i.incident_id}>
                      {i.incident_id} · {i.slice} · {i.title.slice(0, 60)}…
                    </option>
                  ))}
                </select>
                <label className="chk"><input type="checkbox" checked={probesOn} onChange={(e) => setProbesOn(e.target.checked)} disabled={running} /> probes</label>
                <label
                  className="chk"
                  title={
                    opaUp === null ? "OPA reachability unknown"
                      : opaUp ? "OPA reachable — state-changing actions are policy-gated"
                      : "OPA unreachable — gate would fail closed and block the intervention. Run: docker compose up -d opa"
                  }
                >
                  <input type="checkbox" checked={policyOn} onChange={(e) => setPolicyOn(e.target.checked)} disabled={running} /> policy
                  {opaUp === false && <span className="chkHint"> · OPA down</span>}
                </label>
                <label className="chk"><input type="checkbox" checked={executeRollback} onChange={(e) => setExecuteRollback(e.target.checked)} disabled={running} /> execute</label>
                <label className="chk"><input type="checkbox" checked={replay} onChange={(e) => setReplay(e.target.checked)} disabled={running} /> replay</label>
                <button className="btn primary btnInvestigate" onClick={start} disabled={running || !incident}>
                  <IconPlay />
                  <span>{running ? "Investigating…" : "Investigate"}</span>
                </button>
                {incident && (
                  <span className="truth">
                    <span className="dot" style={{ background: "var(--cisco-status-major)" }} />
                    ground truth · <b>{incident.ground_truth.root_cause_id}</b> · rollback {String(incident.ground_truth.rollback_correct)}
                  </span>
                )}
              </div>

              <div className="grid">
                {/* Agent lanes */}
                <section className="card lanes">
                  <h2>Agent Lanes</h2>
                  <div className="body">
                    <div className="laneRow">
                      {AGENTS.map((a) => (
                        <div key={a} className="lane">
                          <div className="laneHead">
                            <span>{AGENT_LABEL[a]}</span>
                            <span className="role">{AGENT_ROLE[a]}</span>
                          </div>
                          <div className="laneBody">
                            {(lanes[a] || []).map((l, i) => (
                              <div key={i} className="laneLine">
                                <span className="ms">{l.t}ms</span>{" "}
                                {l.hyp && <span className="laneLineTag">{l.hyp}</span>}{" "}
                                {l.text.replace(new RegExp(`^${l.hyp}\\s+`), "")}
                              </div>
                            ))}
                            {!(lanes[a] || []).length && <div className="idle">idle</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                {/* Probe ticker */}
                <section className="card ticker">
                  <h2>Probe Selection</h2>
                  <div className="body">
                    {!ambiguity && <div className="idle">awaiting adjudication…</div>}
                    {ambiguity && (
                      <div className={`ambiguity ${ambiguity.resolvable ? "" : "blocked"}`}>
                        <div className="banner">
                          Hypotheses within <b>{ambiguity.margin.toFixed(3)}</b> (τ={ambiguity.tau})
                          {ambiguity.resolvable ? " — selecting discriminating probe…" : " — probes OFF, cannot resolve"}
                        </div>
                        {ambiguity.reason && <div className="why">{ambiguity.reason}</div>}
                        {ambiguity.note && <div className="why">{ambiguity.note}</div>}
                      </div>
                    )}
                    {probeSel && (
                      <div className="probeCard">
                        <div className="pid">{probeSel.probe_id}</div>
                        <div className="pdesc">{probeSel.description}</div>
                        <div className="pmeta">
                          <span className="gain">info-gain {probeSel.info_gain}</span>
                          <span>{probeSel.cost_ms} ms</span>
                        </div>
                      </div>
                    )}
                    {probeRes && (
                      <div className="probeRes">
                        <div className="prLabel">probe returned</div>
                        <div className="prSummary">{probeRes.summary}</div>
                        <div className="prHash">sha256 {probeRes.hash}…</div>
                      </div>
                    )}
                    {exhausted && (
                      <div className="exhausted">
                        budget exhausted — surviving {exhausted.surviving?.join(", ")}; would run next: <b>{exhausted.would_run_next}</b>
                      </div>
                    )}
                  </div>
                </section>

                {/* Hypothesis board */}
                <section className="card board">
                  <h2>Hypothesis Board</h2>
                  <div className="body">
                    {interventionGate && !interventionApproved && (
                      <div className="interventionGate">
                        <div className="ivGateHead">
                          <span className="dot" style={{ background: "var(--cisco-status-critical)" }} />
                          Human Approval Required · Intervention Gated
                        </div>
                        <div className="ivGateDesc">{interventionGate.description}</div>
                        {interventionGate.safety_envelope && (
                          <div className="ivEnv">
                            Safety envelope · max {interventionGate.safety_envelope.max_traffic_pct}% traffic ·
                            bounded {interventionGate.safety_envelope.max_duration_s}s ·
                            auto-revert {String(interventionGate.safety_envelope.auto_revert)}
                          </div>
                        )}
                        <div className="ivReason">
                          Observation VoI has stagnated — passive checks cannot resolve this. A bounded
                          causal test is the highest-value next action. Nothing happens until you approve.
                        </div>
                        <button className="approveBtn" onClick={approveIntervention}>
                          ✓ Approve intervention &amp; execute
                        </button>
                      </div>
                    )}
                    {interventionApproved && interventionResult && (
                      <div className="interventionResult">
                        <div className="ivResultHead">✓ Intervention Executed · {interventionResult.intervention_id}</div>
                        <div className="ivResultSummary">{interventionResult.summary}</div>
                        <div className="ivResultHash">sha256 {interventionResult.hash}…</div>
                      </div>
                    )}
                    {ranked.map((h) => (
                      <div key={h.id} className={`hyp ${h.eliminated ? "dead" : ""} ${verdict?.root_cause_id === h.id && !h.eliminated ? "winner" : ""}`}>
                        <div className="hypTop">
                          <span className="hid">{h.id}</span>
                          <span className="owner">{AGENT_LABEL[h.agent_id] || h.agent_id}</span>
                          {verdict?.root_cause_id === h.id && !h.eliminated && (
                            <span className="pill pill-healthy"><span className="dot" style={{ background: "var(--cisco-status-healthy)" }} />winner</span>
                          )}
                          {h.eliminated && (
                            <span className="pill pill-critical"><span className="dot" style={{ background: "var(--cisco-status-critical)" }} />eliminated</span>
                          )}
                          <span className="pct">{(h.posterior * 100).toFixed(0)}%</span>
                        </div>
                        <div className="claim">{h.claim}</div>
                        <div className="bar"><div className="fill" style={{ width: `${h.posterior * 100}%` }} /></div>
                        {h.eliminated && <div className="elim">✕ {h.eliminated_reason}</div>}
                        {!!h.evidence_refs.length && <div className="refs">{h.evidence_refs.map((r) => r.split("//").pop()).join(" · ")}</div>}
                      </div>
                    ))}
                    {verdict && (
                      <div className="verdict">
                        <div className="vhead">Verdict · {verdict.root_cause_id} @ {(verdict.posterior * 100).toFixed(0)}%</div>
                        <div className="vsum">{verdict.summary}</div>
                        <div className={`rollback ${verdict.rollback_recommended ? "yes" : "no"}`}>
                          rollback {verdict.rollback_recommended ? "recommended" : "not recommended"}
                        </div>
                        {provenance && (
                          <div className={`provenance ${interventionWouldFire ? "wouldbe" : ""}`}>
                            Provenance: {interventionWouldFire ? "interventional (would-be)" : provenance}
                          </div>
                        )}
                        {gate && <div className="gated">⛔ {gate.action} gated — awaiting explicit approval (never auto-fired)</div>}
                      </div>
                    )}
                  </div>
                </section>

                {/* Customer Impact — CIS routing (Sep 16) */}
                <section className="card cis">
                  <h2>Customer Impact <span className="hbadge">CIS</span></h2>
                  <div className="body">
                    {!customerImpact && <div className="idle">no customer_impact block on this incident</div>}
                    {customerImpact && (
                      <div className="cisWrap">
                        <div className={`cisScore urg-${customerImpact.cis_score >= 80 ? "critical" : customerImpact.cis_score >= 55 ? "high" : customerImpact.cis_score >= 30 ? "moderate" : "low"}`}>
                          <div className="cisNum">{Math.round(customerImpact.cis_score)}</div>
                          <div className="cisLbl">
                            {customerImpact.cis_score >= 80 ? "CRITICAL" : customerImpact.cis_score >= 55 ? "HIGH" : customerImpact.cis_score >= 30 ? "MODERATE" : "LOW"}
                          </div>
                        </div>
                        <div className="cisMeta">
                          <div className="cisRow"><span>tier</span><b>{customerImpact.tier || "unspec"}</b></div>
                          <div className="cisRow"><span>affected users</span><b>{customerImpact.affected_users.toLocaleString()}</b></div>
                          <div className="cisRow"><span>SLA breach</span><b>{customerImpact.sla_breach ? "yes" : "no"}</b></div>
                          <div className="cisRow"><span>revenue path</span><b>{customerImpact.revenue_tagged_service ? "yes" : "no"}</b></div>
                          <div className="cisSource">{customerImpact.impact_source}</div>
                          <div className="cisNote">
                            Routing-only — CIS never touches the diagnostic path.
                            <br/>Guardrail proven at build time (static AST audit).
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* Policy Decisions — OPA + Rego (Sep 12-13) */}
                <section className="card policy">
                  <h2>Policy Engine <span className="hbadge">OPA · Rego</span></h2>
                  <div className="body">
                    {!policyDecisions.length && <div className="idle">
                      {policyOn ? "no state-changing action reached the gate yet" : "policy mode OFF — legacy gate flow"}
                    </div>}
                    {policyDecisions.map((pd, i) => (
                      <div key={i} className={`policyRow ${pd.allow ? "allow" : "deny"}`}>
                        <div className="policyHead">
                          <span className={`pill ${pd.allow ? "pill-healthy" : "pill-critical"}`}>
                            <span className="dot" style={{ background: pd.allow ? "var(--cisco-status-healthy)" : "var(--cisco-status-critical)" }} />
                            {pd.allow ? "ALLOW" : "DENY"}
                          </span>
                          <span className="policyAction">{pd.action}</span>
                          {!pd.engine_available && <span className="pill pill-warn">engine unreachable — fail-closed</span>}
                        </div>
                        {pd.description && <div className="policyDesc">{pd.description}</div>}
                        {pd.reasons.length > 0 && (
                          <div className="policyReasons">
                            {pd.reasons.map((r, j) => (<span key={j} className="reasonPill">{r}</span>))}
                          </div>
                        )}
                      </div>
                    ))}
                    {actionBlocked && (
                      <div className="actionBlocked">
                        ⛔ Action blocked: <b>{actionBlocked.action}</b>
                        <div className="reasonList">
                          {actionBlocked.reasons.map((r, i) => (<span key={i} className="reasonPill">{r}</span>))}
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* Verification — post-intervention recovery check (Sep 15) */}
                <section className="card verify">
                  <h2>Verification Loop <span className="hbadge">recovery check</span></h2>
                  <div className="body">
                    {!verification && !verifying && <div className="idle">no intervention run yet</div>}
                    {verifying && <div className="verifying">▸ verifying recovery signal…</div>}
                    {verification && (
                      <div className={`verifyResult ${verification.recovered ? "ok" : "fail"}`}>
                        <div className="verifyHead">
                          <span className={`pill ${verification.recovered ? "pill-healthy" : "pill-critical"}`}>
                            <span className="dot" style={{ background: verification.recovered ? "var(--cisco-status-healthy)" : "var(--cisco-status-critical)" }} />
                            {verification.recovered ? "RECOVERED" : "NOT RECOVERED"}
                          </span>
                          <span className="verifySignal">{verification.signal}</span>
                        </div>
                        <div className="verifyValues">
                          <span>baseline <b>{verification.baseline_value ?? "n/a"}</b></span>
                          <span>post <b>{verification.post_intervention_value ?? "n/a"}</b></span>
                          <span>band ≤ <b>{verification.recovery_band?.max ?? "n/a"}</b></span>
                        </div>
                        {verification.reasoning && <div className="verifyWhy">{verification.reasoning}</div>}
                        {verification.synthesised && <div className="verifyNote">synthesised from ground truth (no explicit block)</div>}
                      </div>
                    )}
                    {autoRevert && (
                      <div className="autoRevert">
                        ↩ Auto-revert triggered: {autoRevert.reason}
                        {autoRevert.safety_envelope && (
                          <div className="envelope">
                            envelope: {autoRevert.safety_envelope.max_traffic_pct}% traffic ·
                            {autoRevert.safety_envelope.max_duration_s}s ·
                            auto-revert {String(autoRevert.safety_envelope.auto_revert)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                {/* Target Service — real HTTP execution against mock (Sep 22) */}
                <section className="card target">
                  <h2>Target Service <span className="hbadge">execution</span></h2>
                  <div className="body">
                    {!targetPre && !rollbackExec && (
                      <div className="idle">
                        target service not reachable — start `mock/shop_svc.py` on :9000 to see it react
                      </div>
                    )}
                    {targetPre && (
                      <div className="targetRow">
                        <div className={`targetSide ${targetPost ? "was" : "cur"}`}>
                          <div className="targetLbl">{targetPost ? "before" : "current state"}</div>
                          <div className="targetVer">{targetPre.version}</div>
                          <div className="targetMetric">
                            <span className="mLbl">5xx</span>
                            <b className={(targetPre.error_rate > 0.1) ? "hot" : ""}>
                              {(targetPre.error_rate * 100).toFixed(1)}%
                            </b>
                          </div>
                          <div className="targetMetric">
                            <span className="mLbl">p95</span>
                            <b className={(targetPre.p95_ms > 1000) ? "hot" : ""}>
                              {targetPre.p95_ms} ms
                            </b>
                          </div>
                          <div className="targetReason">{targetPre.reason}</div>
                        </div>
                        {targetPost && (
                          <>
                            <div className="targetArrow">→</div>
                            <div className="targetSide now">
                              <div className="targetLbl">after rollback</div>
                              <div className="targetVer">{targetPost.version}</div>
                              <div className="targetMetric">
                                <span className="mLbl">5xx</span>
                                <b className={(targetPost.error_rate > 0.1) ? "hot" : "cool"}>
                                  {(targetPost.error_rate * 100).toFixed(1)}%
                                </b>
                              </div>
                              <div className="targetMetric">
                                <span className="mLbl">p95</span>
                                <b className={(targetPost.p95_ms > 1000) ? "hot" : "cool"}>
                                  {targetPost.p95_ms} ms
                                </b>
                              </div>
                              <div className="targetReason">{targetPost.reason}</div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {rollbackExec?.kind === "started" && (
                      <div className="execLine started">▸ real HTTP POST → {rollbackExec.target}/shop/rollback</div>
                    )}
                    {rollbackExec?.kind === "executed" && (
                      <div className="execLine executed">✓ rollback executed against {rollbackExec.target}</div>
                    )}
                    {rollbackExec?.kind === "failed" && (
                      <div className="execLine failed">
                        ⛔ target unreachable — {rollbackExec.error}
                        <div className="execNote">mechanism unaffected — recorded honestly in the audit trail</div>
                      </div>
                    )}
                  </div>
                </section>

                {/* Evidence chain */}
                <section className="card chain">
                  <h2>Evidence Chain</h2>
                  <div className="body">
                    <div className="leaves">
                      {leaves.map((l, i) => (
                        <div key={i} className={`leaf ${l.probe ? "probe" : ""} ${l.intervention ? "intervention" : ""}`}>
                          <span className="lhash">{l.hash ? l.hash.slice(0, 12) : "prior"}</span>
                          <span className="luri">{l.uri.split("//").pop()}</span>
                          {l.intervention && <span className="pill pill-critical">interventional</span>}
                          {l.probe && !l.intervention && <span className="pill pill-info">probe</span>}
                          {!l.probe && !l.intervention && <span className="pill pill-neutral">prior</span>}
                        </div>
                      ))}
                      {!leaves.length && <div className="idle">no evidence cited yet</div>}
                    </div>
                    <div className={`seal ${sealed ? "sealed" : ""}`}>
                      {sealed ? (
                        <>
                          <div className="sealStamp">✓ Sealed · {sealed.leaf_count} leaves</div>
                          <div className="root">merkle {sealed.merkle_root.slice(0, 32)}…</div>
                          <div className="sig">ed25519 {sealed.signature}</div>
                        </>
                      ) : (
                        <div>chain open — computes root on verdict</div>
                      )}
                    </div>
                  </div>
                </section>

                {/* VoI panel */}
                <section className="card voi">
                  <h2>VoI · Value of the Next Action</h2>
                  <div className="body">
                    {!voi && <div className="idle">awaiting action scoring…</div>}
                    {voi && (() => {
                      const obs = voi.actions.filter((a) => a.kind === "observation");
                      const interv = voi.actions.find((a) => a.kind === "intervention");
                      const maxEig = Math.max(1, ...voi.actions.map((a) => a.eig));
                      const argmax = voi.actions.find((a) => a.executable);
                      return (
                        <>
                          {stagnation && (
                            <div className="stagBanner">
                              Observation VoI collapsed → probing is the last productive step in this loop.
                            </div>
                          )}
                          {interventionWouldFire && (
                            <div className="stagBanner fire">
                              Observation exhausted. Intervention would be selected — traffic_shift at 5%, 60s bound. Phase 2 executes; Phase 1 explains.
                            </div>
                          )}
                          {obs.map((a) => (
                            <div key={a.action_id} className={`voiRow ${stagnation ? "stagnated" : ""}`}>
                              <span className="voiLabel">{a.action_id}</span>
                              <div className="voiBar"><div className="voiFill obs" style={{ width: `${Math.max(2, (a.eig / maxEig) * 100)}%` }} /></div>
                              <span className="voiNum">EIG {a.eig.toFixed(2)}</span>
                            </div>
                          ))}
                          {interv && (
                            <div className="voiRow">
                              <span className="voiLabel iv" title="Traffic-shift primitive (5% canary, 60s bound, auto-revert). Specified in our research design (Section 5). Not executed in prototype — see Phase 2.">
                                {interv.action_id.replace("_placeholder", "")} (gated) ⓘ
                              </span>
                              <div className="voiBar"><div className="voiFill iv" style={{ width: `${Math.max(2, (interv.eig / maxEig) * 100)}%` }} /></div>
                              <span className="voiNum">EIG {interv.eig.toFixed(2)}</span>
                            </div>
                          )}
                          <div className="voiArgmax">
                            {verdict
                              ? `Concluded — remaining observation VoI (${obs.length ? Math.max(...obs.map((a) => a.voi_score)).toFixed(2) : "0"}) below margin need`
                              : `Argmax → ${argmax ? `run probe ${argmax.action_id}` : "no executable action — conclude"}`}
                            <span className="voiFormula">voi = eig − λ·cost − μ·risk (λ=0.05, μ=1.0)</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </section>
              </div>
            </>
          )}
          <div className="footer">
            local corpus · local server · offline verifier — <code>python verify.py postmortem.json</code>
          </div>
        </main>
      </div>

      {/* ==================== Modals & dropdowns ==================== */}
      {panel && (
        <div className="modalOverlay" onClick={() => { setPanel(null); setQuery(""); }}>
          <div className={`modalCard ${panel === "alerts" || panel === "user" ? "dropdownCard" : ""}`} onClick={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div className="modalTitle">{
                panel === "bundles" ? "Incident Bundles" :
                panel === "verify"  ? "Offline Evidence Verifier" :
                panel === "docs"    ? "Documentation" :
                panel === "alerts"  ? "Recent Alerts" :
                panel === "user"    ? "Account" :
                panel === "about"   ? "About Incident Commander" : ""
              }</div>
              <button className="modalClose" onClick={() => { setPanel(null); setQuery(""); }}><IconClose /></button>
            </div>
            <div className="modalBody">
              {panel === "bundles" && (
                <>
                  <input
                    type="search" className="modalSearch" placeholder="Filter by id, slice, or title…"
                    value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
                  />
                  <div className="bundleList">
                    {filteredIncidents.length === 0 && <div className="idle">no incidents match “{query}”</div>}
                    {filteredIncidents.map((i) => (
                      <button key={i.incident_id} className={`bundleRow ${sel === i.incident_id ? "on" : ""}`}
                        onClick={() => { setSel(i.incident_id); setPanel(null); setQuery(""); }}>
                        <div className="bundleTop">
                          <span className="hid">{i.incident_id}</span>
                          <span className={`pill pill-${i.slice === "ambiguous" ? "major" : i.slice === "adversarial_redherring" ? "critical" : "info"}`}>{i.slice}</span>
                        </div>
                        <div className="bundleTitle">{i.title}</div>
                        <div className="bundleFoot">
                          truth · <b>{i.ground_truth.root_cause_id}</b> · rollback {String(i.ground_truth.rollback_correct)}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {panel === "verify" && (
                <>
                  <p className="modalText">
                    Every verdict is Merkle-rooted over its cited evidence and Ed25519-signed. Any postmortem can be
                    checked <b>fully offline</b> — no network, no server — with the standalone <code>verify.py</code> tool.
                    Change one byte of any evidence item and the verifier prints TAMPERED.
                  </p>
                  <div className="codeBlock">
                    <div className="codeLine"><span className="codeComment"># 1. Run an investigation and seal its postmortem</span></div>
                    <div className="codeLine">python -m ic.investigate INC-4471 -o postmortem.json</div>
                    <div className="codeLine">&nbsp;</div>
                    <div className="codeLine"><span className="codeComment"># 2. Verify offline — returns exit code 0 on success</span></div>
                    <div className="codeLine">python verify.py postmortem.json</div>
                    <div className="codeLine"><span className="codeComment">→ VERIFIED ✅</span></div>
                  </div>
                  <p className="modalTextSmall">
                    Threat model: post-hoc modification of the reasoning trace by any party after the investigation
                    closes. Relevant to regulated or compliance-sensitive environments.
                  </p>
                </>
              )}
              {panel === "docs" && (
                <div className="docList">
                  <a className="docItem" href="https://github.com/incident-commander-lab/incident-commander/blob/main/README.md" target="_blank" rel="noreferrer">
                    <div className="docTitle">README.md</div>
                    <div className="docDesc">Quickstart, VoI framing, ablation methodology, evidence chain overview.</div>
                  </a>
                  <a className="docItem" href="https://github.com/incident-commander-lab/incident-commander/blob/main/docs/AUTHORING_GUIDE.md" target="_blank" rel="noreferrer">
                    <div className="docTitle">docs/AUTHORING_GUIDE.md</div>
                    <div className="docDesc">How to author a new incident bundle from a real postmortem — schema, invariant, three interpreter types, debug tree.</div>
                  </a>
                  <a className="docItem" href="https://github.com/incident-commander-lab/incident-commander/blob/main/schema/incident_bundle.schema.md" target="_blank" rel="noreferrer">
                    <div className="docTitle">schema/incident_bundle.schema.md</div>
                    <div className="docDesc">Bundle schema, evidence tiers, the one invariant that makes the ablation meaningful.</div>
                  </a>
                </div>
              )}
              {panel === "alerts" && (
                <div className="alertList">
                  <div className="alertItem">
                    <span className="dot" style={{ background: "var(--cisco-status-critical)" }} />
                    <div className="alertBody">
                      <div className="alertTitle">INC-4478 · human approval required</div>
                      <div className="alertMeta">Observation stagnated · intervention gated · 2m ago</div>
                    </div>
                  </div>
                  <div className="alertItem">
                    <span className="dot" style={{ background: "var(--cisco-status-major)" }} />
                    <div className="alertBody">
                      <div className="alertTitle">INC-4472 · rollback recommendation contested</div>
                      <div className="alertMeta">Sibling probe fired · 7m ago</div>
                    </div>
                  </div>
                  <div className="alertItem">
                    <span className="dot" style={{ background: "var(--cisco-status-healthy)" }} />
                    <div className="alertBody">
                      <div className="alertTitle">INC-4471 · verdict sealed</div>
                      <div className="alertMeta">H1 @ 94% · postmortem VERIFIED · 12m ago</div>
                    </div>
                  </div>
                </div>
              )}
              {panel === "user" && (
                <div className="userList">
                  <div className="userInfo">
                    <div className="avatar" style={{ width: 44, height: 44, fontSize: 16 }}>S</div>
                    <div>
                      <div className="userName">Shahesta Mohamed</div>
                      <div className="userMeta">Alryada University</div>
                    </div>
                  </div>
                  <button className="userAction" onClick={() => { setPanel("about"); }}>About Incident Commander</button>
                  <a className="userAction" href="https://github.com/incident-commander-lab/incident-commander" target="_blank" rel="noreferrer">GitHub repository</a>
                  <button className="userAction danger">Sign out</button>
                </div>
              )}
              {panel === "about" && (
                <>
                  <p className="modalText">
                    <b>Incident Commander</b> is a Value-of-Information–guided incident investigator. It treats
                    every candidate next action — an additional observation or a bounded canary intervention —
                    as an action with a computable expected information gain, cost, and risk. It stops observing
                    when observation stagnates, and only then surfaces a human-gated causal test.
                  </p>
                  <div className="aboutMeta">
                    <div><b>Version</b><span>0.4.0 · Cisco UI</span></div>
                    <div><b>Authors</b><span>Nourseen Tarek · Shahesta Mohamed</span></div>
                    <div><b>License</b><span>Research prototype</span></div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
