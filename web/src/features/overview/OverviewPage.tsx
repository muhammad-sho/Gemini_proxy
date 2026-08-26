import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AdminState, type UsageSummary } from "../../api/client.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";

type CellTone = "ok" | "cooling" | "err" | "idle";

export function OverviewPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [usageDays, setUsageDays] = useState<1 | 7>(1);
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const loadUsage = useCallback(async (days: 1 | 7) => {
    try {
      setSummary(await api.getUsageSummary(days));
    } catch {
      /* 401 handled globally; other failures keep the previous summary up */
    }
  }, []);

  useEffect(() => { void loadUsage(usageDays); }, [usageDays, loadUsage]);

  const refreshAll = async () => {
    await reload();
    await loadUsage(usageDays);
  };

  /**
   * Usage matrix — rows are models, columns are provider keys, each cell is
   * the request count for that key×model pair in the selected window, tinted
   * by the pair's live cooldown/health state. Both axes are fully dynamic.
   */
  const matrix = useMemo(() => {
    if (!summary) return null;
    const keyColumns = summary.keys.map(k => ({ ...k }));
    const modelRows = summary.models.map(m => m.id);

    const counts = new Map<string, number>();
    for (const c of summary.cells) counts.set(`${c.providerId}|${c.modelId}`, c.requests);

    const stateByKey = new Map<string, UsageSummary["states"][number]>();
    for (const st of summary.states) stateByKey.set(`${st.credentialId}|${st.modelId}`, st);

    const rows = modelRows.map(modelId => ({
      modelId,
      cells: keyColumns.map(col => {
        const count = counts.get(`${col.id}|${modelId}`) ?? null;
        const st = stateByKey.get(`${col.id}|${modelId}`);
        let tone: CellTone = count !== null ? "ok" : "idle";
        if (st?.state === "cooling" && (st.cooldownUntil ?? 0) > Date.now()) tone = "cooling";
        else if (st?.state === "disabled") tone = "err";
        else if (st && st.errorCount > 0 && count === null) tone = "err";
        return { tone, count };
      })
    }));

    return { keyColumns, rows };
  }, [summary]);

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
        <h2>Usage by key × model</h2>
        <div className="actions" role="group" aria-label="Usage window">
          <button className={`btn ${usageDays === 1 ? "btn-primary" : ""}`} onClick={() => setUsageDays(1)}>Today</button>
          <button className={`btn ${usageDays === 7 ? "btn-primary" : ""}`} onClick={() => setUsageDays(7)}>Last 7 days</button>
        </div>
      </div>

      {!matrix || matrix.rows.length === 0 || matrix.keyColumns.length === 0 ? (
        <p className="hint">No usage to display yet — add a provider credential and start proxying requests.</p>
      ) : (
        <div className="matrix-wrap">
          <table className="table matrix" aria-label="Requests per key and model">
            <thead>
              <tr>
                <th scope="col">Model</th>
                {matrix.keyColumns.map(k => (
                  <th scope="col" key={k.id} title={k.label}>{k.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map(row => (
                <tr key={row.modelId}>
                  <th scope="row" className="matrix-model"><code>{row.modelId}</code></th>
                  {row.cells.map((cell, i) => (
                    <td key={matrix.keyColumns[i].id} className={`matrix-cell cell-${cell.tone}`}>
                      {cell.count === null ? "·" : cell.count}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matrix && matrix.rows.length > 0 && matrix.keyColumns.length > 0 && (
        <p className="hint">
          Requests per provider key × model for the selected window.
          <span className="cell-legend"><span className="matrix-cell cell-ok">n</span> active</span>
          <span className="cell-legend"><span className="matrix-cell cell-cooling">n</span> cooling</span>
          <span className="cell-legend"><span className="matrix-cell cell-err">n</span> failing</span>
          <span className="cell-legend"><span className="matrix-cell cell-idle">·</span> no requests</span>
        </p>
      )}

      <h2>Active cooldowns</h2>
      {state.cooling.length === 0 ? (
        <p className="hint">No keys are cooling down.</p>
      ) : (
        <div className="table-wrap cards"><table className="table">
          <thead>
            <tr><th>Model</th><th>Credential</th><th>Reason</th><th className="num">Cooldown ends in</th></tr>
          </thead>
          <tbody>
            {state.cooling.map(c => (
              <tr key={`${c.model_id}:${c.credential_id}`}>
                <td data-label="Model"><code>{c.model_id}</code></td>
                <td data-label="Credential"><code>{(state.credentials.find(x => x.id === c.credential_id)?.label ?? c.credential_id).slice(0, 20)}</code></td>
                <td data-label="Reason">{c.cooldown_reason ?? "—"}</td>
                <td data-label="Ends in" className="mono num nowrap" title={new Date(c.cooldown_until).toLocaleString()}>
                  {Math.max(0, Math.round((c.cooldown_until - Date.now()) / 1000))}s
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
