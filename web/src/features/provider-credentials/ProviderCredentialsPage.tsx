import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { Modal } from "../../components/Modal.js";

type Credential = AdminState["credentials"][0];

/**
 * Live model picker for the add/edit provider form. Available models are
 * fetched from the upstream at this exact moment (never stored) — the admin
 * moves the ones they want into the selected box, and only that selection is
 * saved on the credential.
 */
function ModelSelector({
  available,
  selected,
  onToggle,
  loading,
  error,
  onRetry
}: {
  available: Array<{ id: string; displayName?: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) return <p className="hint">Fetching models from the provider…</p>;
  if (error) {
    return (
      <p className="hint">
        Could not fetch models: {error}{" "}
        <button type="button" className="btn btn-ghost" onClick={onRetry}>Retry</button>
      </p>
    );
  }
  const remaining = available.filter(m => !selected.includes(m.id));
  if (remaining.length === 0 && selected.length === 0) {
    return <p className="hint">No models returned by the provider.</p>;
  }
  if (remaining.length === 0) {
    return <p className="hint">All returned models are selected.</p>;
  }
  return (
    <div className="model-picker">
      {remaining.map(m => (
        <button key={m.id} type="button" className="model-option" onClick={() => onToggle(m.id)}>
          <span>{m.id}</span>
          <span aria-hidden>＋</span>
        </button>
      ))}
    </div>
  );
}

function CredentialModal({
  editing,
  onClose,
  onSaved
}: {
  editing: Credential | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(editing?.label ?? "");
  const [provider, setProvider] = useState(editing?.provider ?? "gemini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [selected, setSelected] = useState<string[]>(editing?.allowedModels ?? []);
  const [available, setAvailable] = useState<Array<{ id: string; displayName?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const { toast } = useApp();

  const canProbe = editing !== null || apiKey.trim().length > 0;

  const fetchModels = async () => {
    if (!canProbe) return;
    setLoading(true);
    setError(null);
    try {
      const result = editing
        ? await api.getCredentialModels(editing.id)
        : await api.probeProviderModels({ provider, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined });
      setAvailable(result.models);
    } catch (e) {
      setError(String((e as Error).message).slice(0, 200));
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch whenever connection info settles (debounced), or when opening edit.
  useEffect(() => {
    if (!canProbe) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { void fetchModels(); }, 600);
    return () => window.clearTimeout(debounceRef.current);
  }, [editing?.id, provider, apiKey, baseUrl]);

  const toggle = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.updateCredential(editing.id, {
          label: label.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          allowedModels: selected
        });
        toast("info", "Provider credential updated");
      } else {
        await api.createCredential({
          label: label.trim(),
          provider,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          allowedModels: selected
        });
        toast("info", "Provider credential added");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? "Edit provider API key" : "Add provider API key"} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={128} autoFocus />
        </label>
        {!editing && (
          <>
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
          </>
        )}
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
          <legend>Available models (live from the provider — nothing is stored)</legend>
          <ModelSelector
            available={available}
            selected={selected}
            onToggle={toggle}
            loading={loading}
            error={error}
            onRetry={() => void fetchModels()}
          />
        </fieldset>

        <fieldset>
          <legend>Selected models ({selected.length}) — saved with this key</legend>
          {selected.length === 0 ? (
            <p className="hint">Click models above to add them. This credential serves only what is listed here.</p>
          ) : (
            <div className="model-picker">
              {selected.map(id => (
                <button key={id} type="button" className="model-option selected" onClick={() => toggle(id)} title="Remove">
                  <span>{id}</span>
                  <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          )}
        </fieldset>

        <button className="btn btn-primary" disabled={busy || !label.trim() || (!editing && !apiKey.trim()) || selected.length === 0}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add credential"}
        </button>
        {!editing && selected.length === 0 && (
          <p className="hint">Select at least one model to enable saving.</p>
        )}
      </form>
    </Modal>
  );
}

export function ProviderCredentialsPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
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
        <div className="notice">
          <p className="hint hint-first">
            No provider credentials yet. Add your upstream API key, pick the models it serves, and the proxy starts routing.
          </p>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add your first provider key</button>
        </div>
      ) : (
        <div className="table-scroll"><table className="table">
          <thead>
            <tr><th>Label</th><th>Provider</th><th>Base URL</th><th>Models</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {state.credentials.map(c => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td><span className="pill pill-idle">{c.provider}</span></td>
                <td><code>{c.baseUrl ?? "default"}</code></td>
                <td>{c.allowedModels.length > 0 ? `${c.allowedModels.length} selected` : "—"}</td>
                <td>{new Date(c.createdAt * 1000).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-ghost" onClick={() => setEditing(c)}>Edit</button>
                  <ConfirmButton
                    prompt="Delete"
                    warning="Removes this key and its targets from all groups. Applications using it will stop working."
                    onConfirm={() => remove(c.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {(showModal || editing) && (
        <CredentialModal
          editing={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { void reload(); }}
        />
      )}
    </section>
  );
}
