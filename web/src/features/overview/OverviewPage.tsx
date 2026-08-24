import { useCallback, useEffect, useState } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";

function pillClass(count: number): string {
  if (count === 0) return "pill pill-idle";
  return "pill pill-ready";
}

export function OverviewPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      toast("info", okMsg);
    } catch (e) {
      toast("error", String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, [reload, toast]);

  const usageEntries = Object.entries(state.usageByModel).sort((a, b) => b[1] - a[1]);
  const maxUsage = Math.max(1, ...usageEntries.map(e => e[1]));

  return (
    <section className="page">
      <div className="page-header">
        <h1>Overview</h1>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => run(() => api.refreshModels(), "Model cache refreshed")}>
            Refresh models
          </button>
          <ConfirmButton prompt="Clear all cooldowns" onConfirm={async () => { await api.clearCooldowns(); await reload(); }}>
            Clear cooldowns
          </ConfirmButton>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{state.clientKeys.length}</div>
          <div className="stat-label">Client keys</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{state.credentials.length}</div>
          <div className="stat-label">Provider credentials</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{state.models.length}</div>
          <div className="stat-label">Cached models</div>
        </div>
        <div className="stat-card">
          <div className={`stat-value ${state.cooling.length > 0 ? "warn" : ""}`}>{state.cooling.length}</div>
          <div className="stat-label">Cooling keys</div>
        </div>
      </div>

      <h2>Usage by model</h2>
      {usageEntries.length === 0 ? (
        <p className="hint">No requests recorded yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Model</th><th>Requests</th><th /></tr>
          </thead>
          <tbody>
            {usageEntries.map(([model, count]) => (
              <tr key={model}>
                <td><code>{model}</code></td>
                <td>{count}</td>
                <td className="bar-cell"><span className={pillClass(count)} style={{}} data-count={count}>{count === 0 ? "idle" : `${Math.round((count / maxUsage) * 100)}%`}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Active cooldowns</h2>
      {state.cooling.length === 0 ? (
        <p className="hint">No keys are cooling down.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Model</th><th>Credential</th><th>Reason</th><th>Until</th></tr>
          </thead>
          <tbody>
            {state.cooling.map(c => (
              <tr key={`${c.model_id}:${c.credential_id}`}>
                <td><code>{c.model_id}</code></td>
                <td><code>{c.credential_id.slice(0, 13)}…</code></td>
                <td>{c.cooldown_reason ?? "—"}</td>
                <td>{new Date(c.cooldown_until).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
