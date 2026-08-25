import { useState, type FormEvent } from "react";
import { api, type AdminState } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { Modal } from "../../components/Modal.js";
import { SecretReveal } from "../../components/forms.js";

type ClientKey = AdminState["clientKeys"][0];

function CheckList({
  options,
  selected,
  onToggle,
  emptyHint
}: {
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
  emptyHint: string;
}) {
  if (options.length === 0) return <p className="hint">{emptyHint}</p>;
  return (
    <div className="model-picker">
      {options.map(o => (
        <label key={o.value} className="model-option">
          <input type="checkbox" checked={selected.includes(o.value)} onChange={() => onToggle(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function ClientKeyModal({
  editing,
  state,
  onClose,
  onSaved,
  onCreated
}: {
  editing: ClientKey | null;
  state: AdminState;
  onClose: () => void;
  onSaved: () => void;
  onCreated?: (key: { clientApiKey: string }) => void;
}) {
  const [label, setLabel] = useState(editing?.label ?? "");
  const [allowedModels, setAllowedModels] = useState<string[]>(editing?.allowedModels ?? []);
  const [allowedGroups, setAllowedGroups] = useState<string[]>(editing?.allowedGroups ?? []);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const toggleModel = (id: string) =>
    setAllowedModels(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  const toggleGroup = (name: string) =>
    setAllowedGroups(prev => prev.includes(name) ? prev.filter(g => g !== name) : [...prev, name]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.updateClientKey(editing.id, { label: label.trim(), allowedModels, allowedGroups });
        toast("info", "Client key updated");
      } else {
        const created = await api.createClientKey(label.trim(), allowedModels, allowedGroups);
        toast("info", "Client key created");
        onCreated?.(created);
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
    <Modal title={editing ? "Edit client API key" : "Add client API key"} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={128} autoFocus />
        </label>

        <fieldset>
          <legend>Allowed models ({allowedModels.length}) — basic least-used rotation</legend>
          <CheckList
            options={state.models.map(m => ({ value: m.id, label: m.id }))}
            selected={allowedModels}
            onToggle={toggleModel}
            emptyHint="No models available yet — add a provider credential first."
          />
        </fieldset>

        <fieldset>
          <legend>Allowed groups ({allowedGroups.length}) — follow each group's routing role</legend>
          <CheckList
            options={state.groups.map(g => ({
              value: g.name,
              label: `${g.name} (${g.pairs.length} targets · ${g.routingStrategy})`
            }))}
            selected={allowedGroups}
            onToggle={toggleGroup}
            emptyHint="No groups defined yet — create one under the Groups tab."
          />
        </fieldset>

        <button className="btn btn-primary" disabled={busy || !label.trim()}>
          {busy ? "Saving…" : editing ? "Save changes" : "Create key"}
        </button>
        {!editing && allowedModels.length === 0 && allowedGroups.length === 0 && (
          <p className="hint">Leave both empty to allow every model.</p>
        )}
      </form>
    </Modal>
  );
}

export function ClientKeysPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ClientKey | null>(null);
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
            <tr><th>Label</th><th>Models</th><th>Groups</th><th>Created</th><th /></tr>
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
                <td>
                  {k.allowedGroups.length === 0
                    ? <span className="pill pill-idle">none</span>
                    : k.allowedGroups.map(g => <span key={g} className="pill pill-ready">{g}</span>)}
                </td>
                <td>{new Date(k.createdAt * 1000).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-ghost" onClick={() => setEditing(k)}>Edit</button>
                  <ConfirmButton prompt="Delete" onConfirm={() => remove(k.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(showModal || editing) && (
        <ClientKeyModal
          editing={editing}
          state={state}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { void reload(); }}
          onCreated={created => setFreshKey(created.clientApiKey)}
        />
      )}
    </section>
  );
}
