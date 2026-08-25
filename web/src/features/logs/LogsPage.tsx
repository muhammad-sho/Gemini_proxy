import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LogDetail, type LogRow } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { Modal } from "../../components/Modal.js";

const PAGE_SIZE = 25;

const OUTCOMES = ["", "success", "error", "timeout", "aborted", "no_keys"] as const;

function outcomeClass(outcome: string): string {
  if (outcome === "success") return "pill pill-ready";
  if (outcome === "error" || outcome === "no_keys") return "pill pill-error";
  return "pill pill-warn";
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [outcome, setOutcome] = useState<string>("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useApp();

  // Debounce free-text search so typing fires one request, not one per key.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(t);
  }, [query]);
  useEffect(() => { setOffset(0); }, [debouncedQuery]);

  // Monotonic request id: ignore responses that arrive out of order.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await api.listLogs({
        outcome: outcome || undefined,
        q: debouncedQuery || undefined,
        limit: PAGE_SIZE,
        offset
      });
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setLogs(result.logs);
      setTotal(result.total);
    } catch (e) {
      if (seq === requestSeq.current) {
        toast("error", `Could not load logs: ${String((e as Error).message).slice(0, 120)}`);
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [outcome, debouncedQuery, offset, toast]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = async (id: number) => {
    try {
      setDetail(await api.getLog(id));
    } catch (e) {
      toast("error", `Could not open log: ${String((e as Error).message).slice(0, 120)}`);
    }
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="page">
      <div className="page-header">
        <h1>Request logs</h1>
        <div className="actions">
          <select value={outcome} onChange={e => { setOutcome(e.target.value); setOffset(0); }}>
            {OUTCOMES.map(o => <option key={o} value={o}>{o === "" ? "All outcomes" : o}</option>)}
          </select>
          <input
            className="search"
            placeholder="Search bodies…"
            value={query}
            onChange={e => { setQuery(e.target.value); setOffset(0); }}
          />
        </div>
      </div>

      <table className="table logs-table">
        <thead>
          <tr><th>Time</th><th>Model</th><th>Status</th><th>Outcome</th><th>Attempts</th><th>Latency</th></tr>
        </thead>
        <tbody>
          {logs.map(l => (
            <tr
              key={l.id}
              className="row-click"
              tabIndex={0}
              role="button"
              aria-label={`Open log ${l.traceId.slice(0, 8)}`}
              onClick={() => void openDetail(l.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openDetail(l.id); } }}
            >
              <td>{new Date(l.createdAt * 1000).toLocaleTimeString()}</td>
              <td><code>{l.modelId ?? "—"}</code></td>
              <td>{l.responseStatus ?? "—"}</td>
              <td><span className={outcomeClass(l.finalOutcome)}>{l.finalOutcome}</span></td>
              <td>{l.attemptNumber}/{l.totalAttempts}</td>
              <td>{l.latencyMs != null ? `${l.latencyMs}ms` : "—"}</td>
            </tr>
          ))}
          {!loading && logs.length === 0 && (
            <tr><td colSpan={6}><span className="hint">No matching log entries.</span></td></tr>
          )}
          {loading && <tr><td colSpan={6}><span className="hint">Loading…</span></td></tr>}
        </tbody>
      </table>

      <div className="pager">
        <button className="btn btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</button>
        <span>Page {page} / {pages} · {total} entries</span>
        <button className="btn btn-ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</button>
      </div>

      {detail && <LogDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function LogDetailModal({ detail, onClose }: { detail: LogDetail; onClose: () => void }) {
  let reqPretty = detail.request_body ?? "";
  let resPretty = detail.response_body ?? "";
  try { reqPretty = JSON.stringify(JSON.parse(reqPretty), null, 2); } catch { /* keep raw */ }
  try { resPretty = JSON.stringify(JSON.parse(resPretty), null, 2); } catch { /* keep raw */ }

  return (
    <Modal title={`Request ${detail.trace_id.slice(0, 8)}…`} onClose={onClose}>
      <dl className="detail-grid">
        <dt>Path</dt><dd><code>{detail.method} {detail.path}</code></dd>
        <dt>Status</dt><dd>{detail.response_status ?? "—"}</dd>
        <dt>Outcome</dt><dd><span className={outcomeClass(detail.final_outcome)}>{detail.final_outcome}</span></dd>
        <dt>Classification</dt><dd>{detail.error_classification ?? "—"}</dd>
        <dt>Attempts</dt><dd>{detail.attempt_number}/{detail.total_attempts}</dd>
        <dt>Latency</dt><dd>{detail.latency_ms ?? "—"}ms</dd>
      </dl>

      <h3>Timeline</h3>
      <ol className="timeline">
        {detail.timeline.map((ev, i) => (
          <li key={i}>
            <code className="tl-time">{new Date(ev.at).toLocaleTimeString()}</code>
            <strong>{ev.event}</strong>
            {ev.detail !== undefined && <pre className="tl-detail">{JSON.stringify(ev.detail)}</pre>}
          </li>
        ))}
      </ol>

      <h3>Request body</h3>
      <pre className="body-view">{reqPretty || "(empty)"}</pre>

      <h3>Response body</h3>
      <pre className="body-view">{resPretty || "(empty)"}</pre>
    </Modal>
  );
}
