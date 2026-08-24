import { useState } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { ClientKeyModal, SecretReveal } from "../../components/forms.js";

export function ClientKeysPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const { toast } = useApp();

  const remove = async (id: string) => {
    try {
      await api.deleteClientKey(id);
      toast("info", "Key deleted");
      await reload();
    } catch (e) {
      toast("error", String((e as Error).message));
    }
  };

  return (
    <section className="page">
      <div className="page-header">
        <h1>Client API keys</h1>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add client API key</button>
        </div>
      </div>

      {freshKey && (
        <div className="notice">
          <strong>New key created — copy it now, it will not be shown again.</strong>
          <SecretReveal secret={freshKey} />
          <button className="btn btn-ghost" onClick={() => setFreshKey(null)}>Dismiss</button>
        </div>
      )}

      {state.clientKeys.length === 0 ? (
        <p className="hint">No client keys yet. Create one to start proxying requests.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Label</th><th>Allowed models</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {state.clientKeys.map(k => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td>
                  {k.allowedModels.length === 0
                    ? <span className="pill pill-ready">all models</span>
                    : k.allowedModels.map(m => <span key={m} className="pill pill-idle">{m}</span>)}
                </td>
                <td>{new Date(k.createdAt * 1000).toLocaleDateString()}</td>
                <td>
                  <ConfirmButton prompt="Delete" onConfirm={() => remove(k.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <ClientKeyModal
          models={state.models}
          onClose={() => setShowModal(false)}
          onCreated={created => setFreshKey(created.clientApiKey)}
        />
      )}
    </section>
  );
}
