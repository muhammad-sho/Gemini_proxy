import { useCallback, useEffect, useState } from "react";
import { api, type AdminState, type UsageSummary } from "../../api/client.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";

function pillClass(count: number): string {
  if (count === 0) return "pill pill-idle";
  return "pill pill-ready";
}

export function OverviewPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [usageDays, setUsageDays] = useState<1 | 7>(1);
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const loadUsage = useCallback(async (days: 1 | 7) => {
    try {
      setSummary(await api.getUsageSummary(days));
    } catch {
      /* 401 handled globally; other failures leave the previous summary up */
    }
  }, []);

  useEffect(() => { void loadUsage(usageDays); }, [usageDays, loadUsage]);

  const refreshAll = async () => {
    await reload();
    await loadUsage(usageDays);
  };

  return (
    <section className="page">
      <div className="page-header">
        <h1>Overview</h1>
        <div className="actions">
          <ConfirmButton prompt="Clear all cooldowns" onConfirm={async () => { await api.clearCooldowns(); await refreshAll(); }}>
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
          <div className="stat-value">{state.groups.length}</div>
          <div className="stat-label">Groups</div>
        </div>
        <div className="stat-card">
          <div className={`stat-value ${state.cooling.length > 0 ? "warn" : ""}`}>{state.cooling.length}</div>
          <div className="stat-label">Cooling keys</div>
        </div>
      </div>

      <div className="page-header">
        <h2>Usage</h2>
        <div className="actions" role="group" aria-label="Usage window">
          <button className={`btn ${usageDays === 1 ? "btn-primary" : ""}`} onClick={() => setUsageDays(1)}>Today</button>
          <button className={`btn ${usageDays === 7 ? "btn-primary" : ""}`} onClick={() => setUsageDays(7)}>Last 7 days</button>
        </div>
      </div>
      {!summary || summary.models.length === 0 ? (
        <p className="hint">No requests recorded in this window.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Model</th><th>Requests</th><th>Prompt tokens</th><th>Completion tokens</th></tr>
          </thead>
          <tbody>
            {summary.models.map(m => (
              <tr key={m.modelId}>
                <td><code>{m.modelId}</code></td>
                <td><span className={pillClass(m.requests)}>{m.requests}</span></td>
                <td>{m.promptTokens.toLocaleString()}</td>
                <td>{m.completionTokens.toLocaleString()}</td>
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
                <td><code>{(state.credentials.find(x => x.id === c.credential_id)?.label ?? c.credential_id).slice(0, 20)}</code></td>
                <td>{c.cooldown_reason ?? "—"}</td>
                <td title={new Date(c.cooldown_until).toLocaleString()}>
                  {Math.max(0, Math.round((c.cooldown_until - Date.now()) / 1000))}s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
