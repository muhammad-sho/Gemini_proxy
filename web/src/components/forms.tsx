import { useState, type FormEvent } from "react";
import { useApp } from "../auth/useAuth.js";
import { Modal } from "./Modal.js";
import { api } from "../api/client.js";

export function ModelPicker({
  models,
  selected,
  onChange
}: {
  models: Array<{ id: string; displayName?: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter(m => m !== id) : [...selected, id]);
  };
  if (models.length === 0) {
    return <p className="hint">No cached models yet — refresh models first, or leave empty for full access.</p>;
  }
  return (
    <div className="model-picker">
      {models.map(m => (
        <label key={m.id} className="model-option">
          <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
          <span>{m.id}</span>
        </label>
      ))}
    </div>
  );
}

export function ClientKeyModal({
  models,
  onClose,
  onCreated
}: {
  models: Array<{ id: string }>;
  onClose: () => void;
  onCreated: (key: { clientApiKey: string }) => void;
}) {
  const [label, setLabel] = useState("");
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api.createClientKey(label.trim(), allowedModels);
      toast("info", "Client key created");
      onCreated(created);
      onClose();
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add client API key" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={128} autoFocus />
        </label>
        <fieldset>
          <legend>Allowed models (empty = all)</legend>
          <ModelPicker models={models} selected={allowedModels} onChange={setAllowedModels} />
        </fieldset>
        <button className="btn btn-primary" disabled={busy || !label.trim()}>
          {busy ? "Creating…" : "Create key"}
        </button>
      </form>
    </Modal>
  );
}

export function SecretReveal({ secret }: { secret: string }) {
  return (
    <div className="secret-reveal">
      <code>{secret}</code>
      <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(secret)}>
        Copy
      </button>
    </div>
  );
}
