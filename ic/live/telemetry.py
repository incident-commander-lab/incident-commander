"""TelemetryStore — an in-memory time-series store fed by OTLP pushes.

Plays the role Prometheus/Mimir plays in production: the live detector,
investigation probes and verification all read telemetry through these
queries, never from the target service's internal state.

Only DELTA sums and DELTA explicit-bucket histograms are stored, because that
is what the target exports. Quantiles are estimated from merged bucket counts
with linear interpolation inside the bucket — the same method as PromQL's
histogram_quantile — so they carry bucket-resolution error, not exact values.
"""
from __future__ import annotations

import math
import threading
import time
from bisect import bisect_left, bisect_right
from collections import Counter, deque
from dataclasses import dataclass
from typing import Callable, Optional

from ..otlp import OtlpMetricsPayload

RETENTION_S = 900.0
MAX_FUTURE_S = 300.0   # a point stamped further ahead than this is clock skew or poisoning, not telemetry


@dataclass(frozen=True)
class Point:
    t: float                     # interval end, unix seconds
    service: str
    metric: str
    attrs: tuple                 # sorted (key, value) pairs
    value: float = 0.0           # sums
    counts: tuple = ()           # histograms: bucket counts
    bounds: tuple = ()
    total: float = 0.0           # histogram sum

    def attr(self, key: str):
        for k, v in self.attrs:
            if k == key:
                return v
        return None


def _matches(p: Point, where: Optional[dict]) -> bool:
    return not where or all(p.attr(k) == v for k, v in where.items())


def quantile_from_buckets(q: float, counts: list[float], bounds: list[float]) -> Optional[float]:
    total = sum(counts)
    if total <= 0:
        return None
    rank = q * total
    cum = 0.0
    for i, c in enumerate(counts):
        if cum + c >= rank and c > 0:
            lower = bounds[i - 1] if i > 0 else 0.0
            upper = bounds[i] if i < len(bounds) else bounds[-1] * 1.5  # overflow bucket
            return lower + (upper - lower) * ((rank - cum) / c)
        cum += c
    return bounds[-1]


class TelemetryStore:
    def __init__(self, retention_s: float = RETENTION_S) -> None:
        # metric → points sorted by t, plus a parallel list of t for bisect.
        self._by_metric: dict[str, list[Point]] = {}
        self._times: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._covered = threading.Condition(self._lock)
        self.retention_s = retention_s
        self.ingested_batches = 0
        self.last_ingest_at: Optional[float] = None
        self.max_point_t = 0.0          # newest interval end ingested so far
        self.ingest_lag_s: deque[float] = deque(maxlen=120)  # wall arrival − interval end
        self.rejected: Counter = Counter()  # reason -> data points dropped at ingest

    # --- write ----------------------------------------------------------------

    def _time(self, nano, now: float) -> float:
        t = int(nano) / 1e9          # ValueError on a non-numeric timestamp
        if t <= 0 or t > now + MAX_FUTURE_S:
            raise ValueError("timestamp_out_of_range")
        return t

    def ingest(self, payload: OtlpMetricsPayload) -> int:
        """Store every well-formed data point; drop the rest and count why (self.rejected).
        A point that would poison the detector's or verification's queries — no service, a
        timestamp that cannot be parsed or lies in the future, a non-finite or negative value,
        a histogram whose buckets do not add up — never reaches them."""
        new: list[Point] = []
        now = time.time()
        for rm in payload.resourceMetrics:
            service = rm.resource.get("service.name", "")   # absent: not attributable, so not stored
            for sm in rm.scopeMetrics:
                for m in sm.metrics:
                    dps = m.sum.dataPoints if m.sum is not None else (m.histogram.dataPoints if m.histogram is not None else [])
                    for dp in dps:
                        try:
                            if not service:
                                raise ValueError("missing_service_name")
                            t = self._time(dp.timeUnixNano, now)
                            attrs = tuple(sorted((kv.key, kv.value.unwrap()) for kv in dp.attributes))
                            if m.sum is not None:
                                v = dp.value()
                                if not math.isfinite(v) or v < 0:
                                    raise ValueError("bad_value")
                                new.append(Point(t=t, service=service, metric=m.name, attrs=attrs, value=v))
                            else:
                                counts = tuple(int(c) for c in dp.bucketCounts)
                                bounds = tuple(float(b) for b in dp.explicitBounds)
                                total = float(dp.sum or 0.0)
                                if (any(c < 0 for c in counts) or len(counts) != len(bounds) + 1
                                        or any(not math.isfinite(b) for b in bounds) or list(bounds) != sorted(set(bounds))
                                        or not math.isfinite(total) or total < 0):
                                    raise ValueError("bad_histogram")
                                new.append(Point(t=t, service=service, metric=m.name, attrs=attrs,
                                                 counts=counts, bounds=bounds, total=total))
                        except (ValueError, TypeError) as e:
                            reason = str(e) if str(e) in ("missing_service_name", "timestamp_out_of_range",
                                                          "bad_value", "bad_histogram") else "unparseable"
                            self.rejected[reason] += 1
        if not new:
            return 0
        cutoff = now - self.retention_s
        with self._covered:
            for p in new:
                pts = self._by_metric.setdefault(p.metric, [])
                ts = self._times.setdefault(p.metric, [])
                i = bisect_right(ts, p.t)
                pts.insert(i, p)
                ts.insert(i, p.t)
            for metric, ts in self._times.items():
                k = bisect_left(ts, cutoff)
                if k:
                    del ts[:k]
                    del self._by_metric[metric][:k]
            newest = max(p.t for p in new)
            self.ingest_lag_s.append(now - newest)
            self.max_point_t = max(self.max_point_t, newest)
            self.ingested_batches += 1
            self.last_ingest_at = now
            self._covered.notify_all()
        return len(new)

    def wait_until_covered(self, t: float, timeout_s: float = 5.0) -> bool:
        """Block until telemetry for every interval ending at or before `t` has
        arrived — i.e. a later interval has been ingested. Queries over a window
        must not run while the tail of that window is still in flight."""
        deadline = time.time() + timeout_s
        with self._covered:
            while self.max_point_t <= t:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return False
                self._covered.wait(remaining)
            return True

    # --- read -----------------------------------------------------------------

    def _window(self, metric: str, t0: float, t1: float, where: Optional[dict],
                service: Optional[str]) -> list[Point]:
        with self._lock:
            ts = self._times.get(metric)
            if not ts:
                return []
            pts = self._by_metric[metric][bisect_right(ts, t0):bisect_right(ts, t1)]
        return [p for p in pts if _matches(p, where) and (service is None or p.service == service)]

    def sum(self, metric: str, t0: float, t1: float, where: Optional[dict] = None,
            group_by: Optional[str] = None, service: Optional[str] = None) -> dict:
        out: dict = {}
        for p in self._window(metric, t0, t1, where, service):
            key = p.attr(group_by) if group_by else "_all"
            out[key] = out.get(key, 0.0) + p.value
        return out

    def quantile(self, metric: str, q: float, t0: float, t1: float, where: Optional[dict] = None,
                 service: Optional[str] = None) -> tuple[Optional[float], int]:
        merged: Optional[list[float]] = None
        bounds: list[float] = []
        for p in self._window(metric, t0, t1, where, service):
            if merged is None:
                merged, bounds = [0.0] * len(p.counts), list(p.bounds)
            for i, c in enumerate(p.counts):
                merged[i] += c
        if merged is None:
            return None, 0
        return quantile_from_buckets(q, merged, bounds), int(sum(merged))

    # --- derived signals used across live mode -----------------------------------

    def request_stats(self, t0: float, t1: float, where: Optional[dict] = None) -> dict:
        by_class = self.sum("http.server.request.count", t0, t1, where=where,
                            group_by="http.response.status_class")
        total = sum(by_class.values())
        errors = by_class.get("5xx", 0.0)
        p95, _ = self.quantile("http.server.request.duration", 0.95, t0, t1, where=where)
        return {"requests": int(total), "errors": int(errors),
                "error_rate": (errors / total) if total else None,
                "p95_ms": p95, "rps": total / max(t1 - t0, 1e-9)}

    def errors_by_version(self, t0: float, t1: float) -> dict:
        out: dict[str, dict] = {}
        for p in self._window("http.server.request.count", t0, t1, None, None):
            v = p.attr("service.version")
            row = out.setdefault(v, {"requests": 0, "errors": 0})
            row["requests"] += int(p.value)
            if p.attr("http.response.status_class") == "5xx":
                row["errors"] += int(p.value)
        return out

    def dependency_stats(self, dep: str, t0: float, t1: float) -> dict:
        outcomes = self.sum("dependency.client.request.count", t0, t1,
                            where={"peer.service": dep}, group_by="outcome")
        total = sum(outcomes.values())
        errors = outcomes.get("error", 0.0)
        p95, n = self.quantile("dependency.client.duration", 0.95, t0, t1, where={"peer.service": dep})
        return {"calls": int(total), "errors": int(errors),
                "error_rate": (errors / total) if total else None,
                "p95_ms": p95, "latency_samples": n}

    def series(self, fn: Callable[[float, float], Optional[float]], t0: float, t1: float,
               step: float) -> list[list]:
        """[[iso8601, value], ...] — the shape the replay reasoner's series
        helpers already consume, so the three agents read live data unchanged."""
        from datetime import datetime, timezone
        out = []
        t = t0
        while t + step <= t1 + 1e-9:
            v = fn(t, t + step)
            if v is not None:
                ts = datetime.fromtimestamp(t + step, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                out.append([ts, round(float(v), 3)])
            t += step
        return out

    def active_versions(self, t0: float, t1: float) -> list[str]:
        return sorted(v for v in self.errors_by_version(t0, t1) if v)

    def has_traffic(self, window_s: float = 5.0, now: Optional[float] = None) -> bool:
        now = now or time.time()
        return self.request_stats(now - window_s, now)["requests"] > 0
