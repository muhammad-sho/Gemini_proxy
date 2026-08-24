import { useState, type FormEvent } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { ModelPicker } from "../../components/forms.js";
import { Modal } from "../../components/Modal.js";

function AddCredentialModal({
  models,
  onClose,
  onCreated
}: {
  models: Array<{ id: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState("gemini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createCredential({
        label: label.trim(),
        provider,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        allowedModels
      });
      toast("info", "Provider credential added");
      onCreated();
      onClose();
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add provider API key" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={128} autoFocus />
        </label>
        <label>
          Provider
          <select value={provider} onChange={e => setProvider(e.target.value)}>
            <option value="gemini">Google Gemini</option>
            <option value="openai_compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label>
          API key
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} required autoComplete="off" />
        </label>
        <label>
          Base URL (optional)
          <input
            type="url"
            placeholder={provider === "gemini" ? "https://generativelanguage.googleapis.com" : "https://api.openai.com"}
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Allowed models (empty = all cached models)</legend>
          <ModelPicker models={models} selected={allowedModels} onChange={setAllowedModels} />
        </fieldset>
        <button className="btn btn-primary" disabled={busy || !label.trim() || !apiKey.trim()}>
          {busy ? "Adding…" : "Add credential"}
        </button>
      </form>
    </Modal>
  );
}

function EditCredentialModal({
  credential,
  models,
  onClose,
  onUpdated
}: {
  credential: AdminState["credentials"][0];
  models: Array<{ id: string }>;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [label, setLabel] = useState(credential.label);
  const [baseUrl, setBaseUrl] = useState(credential.baseUrl ?? "");
  const [allowedModels, setAllowedModels] = useState<string[]>(credential.allowedModels ?? []);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateCredential(credential.id, {
        label: label.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        allowedModels: allowedModels.length > 0 ? allowedModels : undefined
      });
      toast("info", "Provider credential updated");
      onUpdated();
      onClose();
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Edit provider API key" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={128} autoFocus />
        </label>
        <label>
          Base URL (optional)
          <input
            type="url"
            placeholder={credential.provider === "gemini" ? "https://generativelanguage.googleapis.com" : "https://api.openai.com"}
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </label>
        <p className="hint">Provider: <strong>{credential.provider}</strong></p>
        <fieldset>
          <legend>Allowed models (empty = all cached models)</legend>
          <ModelPicker models={models} selected={allowedModels} onChange={setAllowedModels} />
        </fieldset>
        <button className="btn btn-primary" disabled={busy || !label.trim()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}

export function ProviderCredentialsPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<AdminState["credentials"][0] | null>(null);
  const { toast } = useApp();

  const remove = async (id: string) => {
    try {
      await api.deleteCredential(id);
      toast("info", "Credential deleted");
      await reload();
    } catch (e) {
      toast("error", String((e as Error).message));
    }
  };

  return (
    <section className="page">
      <div className="page-header">
        <h1>Provider credentials</h1>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add provider API key</button>
        </div>
      </div>

      {state.credentials.length === 0 ? (
        <p className="hint">No provider credentials yet. Add at least one to serve requests.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Label</th><th>Provider</th><th>Base URL</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {state.credentials.map(c => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td><span className="pill pill-idle">{c.provider}</span></td>
                <td><code>{c.baseUrl ?? "default"}</code></td>
                <td>{new Date(c.createdAt * 1000).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-ghost" onClick={() => setEditing(c)}>Edit</button>
                  <ConfirmButton prompt="Delete" onConfirm={() => remove(c.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <AddCredentialModal
          models={state.models}
          onClose={() => setShowModal(false)}
          onCreated={() => { void reload(); }}
        />
      )}
      {editing && (
        <EditCredentialModal
          credential={editing}
          models={state.models}
          onClose={() => setEditing(null)}
          onUpdated={() => { void reload(); }}
        />
      )}
    </section>
  );
}
