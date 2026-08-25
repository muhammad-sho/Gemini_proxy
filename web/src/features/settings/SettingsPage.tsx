import { useEffect, useState } from "react";
import { api, type ProxySettings } from "../../api/client.js";
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
  { key: "modelsCacheTtlHours", label: "Model cache TTL (hours)", hint: "How long cached model lists stay fresh (1–168)", min: 1, max: 168 }
];

const LOG_FIELDS: NumberField[] = [
  { key: "logBodyMaxBytes", label: "Stored body bytes", hint: "Max request/response bytes kept per log entry (1024–5242880)", min: 1024, max: 5242880 },
  { key: "maxLogEntries", label: "Log retention (entries)", hint: "Oldest request logs are pruned beyond this count (50–100000)", min: 50, max: 100000 }
];

export function SettingsPage() {
  const [values, setValues] = useState<ProxySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  useEffect(() => {
    api.getSettings().then(setValues).catch(() => { /* 401 handled globally */ });
  }, []);

  if (!values) return <p className="hint center">Loading…</p>;

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
              onChange={e => setValues({ ...values, [f.key]: Number(e.target.value) })}
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
              onChange={e => setValues({ ...values, [f.key]: Number(e.target.value) })}
            />
            <small className="hint">{f.hint}</small>
          </label>
        ))}
      </form>
    </section>
  );
}
