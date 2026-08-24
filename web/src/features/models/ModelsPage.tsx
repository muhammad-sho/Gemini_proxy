import { useState } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";

export function ModelsPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const refresh = async () => {
    setBusy(true);
    try {
      const result = await api.refreshModels();
      await reload();
      toast("info", `Refreshed ${result.refreshed} model entries`);
      if (result.errors.length > 0) {
        toast("error", `${result.errors.length} credential(s) failed: ${result.errors[0]}`);
      }
    } catch (e) {
      toast("error", String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const filtered = state.models.filter(m =>
    query === "" || m.id.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <section className="page">
      <div className="page-header">
        <h1>Models</h1>
        <div className="actions">
          <input
            className="search"
            placeholder="Filter models…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy} onClick={refresh}>
            {busy ? "Refreshing…" : "Refresh cache"}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="hint">{state.models.length === 0 ? "Model cache is empty — add a provider credential and refresh." : "No models match the filter."}</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Model ID</th><th>Display name</th></tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.id}>
                <td><code>{m.id}</code></td>
                <td>{m.displayName ?? m.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
