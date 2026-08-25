import { useCallback, useEffect, useState } from "react";
import { api, type AuditEntry, type ProxySettings } from "../../api/client.js";
import { relTime } from "../../lib/relTime.js";
import { useApp } from "../../auth/useAuth.js";

interface NumberField {
  key: keyof ProxySettings;
  label: string;
  hint: string;
  min: number;
  max: number;
}

const ROUTING_FIELDS: NumberField[] = [
  { key: "keyFallbackAttempts", label: "Upstream attempts", hint: "Tries per request before relaying the last response (1–10)", min: 1, max: 10 },
  { key: "keyLoopDeadlineMs", label: "Total deadline (ms)", hint: "Time budget for all attempts of one request (1000–600000)", min: 1000, max: 600000 },
  { key: "requestTimeoutMs", label: "Per-attempt timeout (ms)", hint: "Upstream timeout for each individual attempt (1000–600000)", min: 1000, max: 600000 },
];

const LIMIT_FIELDS: NumberField[] = [
  { key: "rateLimitPerMinute", label: "Requests / IP / minute", hint: "Global per-address cap on all three surfaces; applies on restart (10–10000)", min: 10, max: 10000 },
  { key: "clientKeyRatePerMinute", label: "Requests / client key / minute", hint: "Gateway cap per client key; 0 disables per-key limiting (0–100000)", min: 0, max: 100000 }
];

const LOG_FIELDS: NumberField[] = [
  { key: "logBodyMaxBytes", label: "Stored body bytes", hint: "Max request/response bytes kept per log entry (1024–5242880)", min: 1024, max: 5242880 },
  { key: "maxLogEntries", label: "Retention (entries)", hint: "Oldest request logs and usage events are pruned beyond this count (50–100000)", min: 50, max: 100000 }
];

export function SettingsPage() {
  const [values, setValues] = useState<ProxySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<{ total: number; actions: string[]; logs: AuditEntry[] } | null>(null);
  const [auditAction, setAuditAction] = useState("");
  const { toast } = useApp();

  useEffect(() => {
    api.getSettings().then(setValues).catch(() => { /* 401 handled globally */ });
  }, []);

  const loadAudit = useCallback((action: string) => {
    api.listAuditLogs({ action: action || undefined, limit: 50 })
      .then(setAudit)
      .catch(() => { /* non-fatal */ });
  }, []);

  useEffect(() => { loadAudit(auditAction); }, [auditAction, loadAudit]);

  if (!values) return <p className="hint center">Loading…</p>;

  /** Clamp to the field's bounds immediately — no garbage reaches the server. */
  const setValue = (key: keyof ProxySettings, raw: string, min: number, max: number) => {
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    setValues({ ...values, [key]: Math.min(max, Math.max(min, Math.round(num))) });
  };

  const save = async () => {
    setBusy(true);
    try {
      setValues(await api.updateSettings(values));
      toast("info", "Settings saved and applied immediately");
    } catch (e) {
      toast("error", String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <div className="actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="hint">Changes apply immediately — no restart needed. Deployment concerns (ports, hosts) stay in the environment.</p>

      <h2>Routing</h2>
      <form className="form settings-form" onSubmit={e => e.preventDefault()}>
        {ROUTING_FIELDS.map(f => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={values[f.key]}
              onChange={e => setValue(f.key, e.target.value, f.min, f.max)}
            />
            <small className="hint">{f.hint}</small>
          </label>
        ))}
      </form>

      <h2>Limits</h2>
      <form className="form settings-form" onSubmit={e => e.preventDefault()}>
        {LIMIT_FIELDS.map(f => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={values[f.key]}
              onChange={e => setValue(f.key, e.target.value, f.min, f.max)}
            />
            <small className="hint">{f.hint}</small>
          </label>
        ))}
      </form>

      <h2>Request logs</h2>
      <form className="form settings-form" onSubmit={e => e.preventDefault()}>
        {LOG_FIELDS.map(f => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={values[f.key]}
              onChange={e => setValue(f.key, e.target.value, f.min, f.max)}
            />
            <small className="hint">{f.hint}</small>
          </label>
        ))}
      </form>

      <h2>Security log</h2>
      <div className="actions">
        <select
          value={auditAction}
          aria-label="Filter by action"
          onChange={e => setAuditAction(e.target.value)}
        >
          <option value="">All actions</option>
          {(audit?.actions ?? []).map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {audit && <span className="hint">{audit.total} entries</span>}
      </div>
      {!audit || audit.logs.length === 0 ? (
        <p className="hint">Nothing recorded yet.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
          <tbody>
            {audit.logs.map(l => (
              <tr key={l.id}>
                <td title={new Date(l.createdAt * 1000).toLocaleString()}>{relTime(l.createdAt)}</td>
                <td><span className="pill pill-idle">{l.action}</span></td>
                <td><code>{[l.entityType, l.entityId].filter(Boolean).join(":") || "—"}</code></td>
                <td>{l.ipAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}


