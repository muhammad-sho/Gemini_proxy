import { useState, type FormEvent } from "react";
import { api, type AdminState, type Group, type GroupPair } from "../../api/client.js";
import { useApp } from "../../auth/useAuth.js";
import { ConfirmButton } from "../../components/ConfirmButton.js";
import { Modal } from "../../components/Modal.js";

const STRATEGIES: Array<{ value: Group["routingStrategy"]; label: string }> = [
  { value: "least_used", label: "Least used — spread load evenly" },
  { value: "round_robin", label: "Round robin — strict rotation" },
  { value: "fastest", label: "Fastest — lowest measured latency first" },
  { value: "smartest", label: "Smartest — fewest errors, then fastest" }
];

function GroupModal({
  editing,
  state,
  onClose,
  onSaved
}: {
  editing: Group | null;
  state: AdminState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [routingStrategy, setRoutingStrategy] = useState<Group["routingStrategy"]>(editing?.routingStrategy ?? "least_used");
  const [fallbackStrategy, setFallbackStrategy] = useState<Group["fallbackStrategy"]>(editing?.fallbackStrategy ?? null);
  const [pairs, setPairs] = useState<GroupPair[]>(editing?.pairs ?? []);
  const [credentialId, setCredentialId] = useState(state.credentials[0]?.id ?? "");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const credential = state.credentials.find(c => c.id === credentialId);
  const credentialModels = credential?.allowedModels ?? [];

  // Pairs whose credential no longer selects the model (e.g. edited after the
  // group was built) would silently route nowhere — flag them and clean on save.
  const isStale = (p: GroupPair) => {
    const cred = state.credentials.find(c => c.id === p.credentialId);
    return !cred || !cred.allowedModels.includes(p.modelId);
  };
  const stalePairs = pairs.filter(isStale);

  const addPair = () => {
    if (!credentialId || !modelId) return;
    if (pairs.some(p => p.credentialId === credentialId && p.modelId === modelId)) return;
    setPairs([...pairs, { credentialId, modelId }]);
    setModelId("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cleaned = pairs.filter(p => !isStale(p));
    try {
      if (editing) {
        await api.updateGroup(editing.id, {
          name: name.trim(),
          description: description.trim(),
          routingStrategy,
          fallbackStrategy,
          pairs: cleaned
        });
        toast("info", cleaned.length < pairs.length
          ? `Group updated (${pairs.length - cleaned.length} stale target${pairs.length - cleaned.length > 1 ? "s" : ""} removed)`
          : "Group updated");
      } else {
        await api.createGroup({
          name: name.trim(),
          description: description.trim(),
          routingStrategy,
          fallbackStrategy,
          pairs: cleaned
        });
        toast("info", "Group created");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const labelFor = (id: string) => state.credentials.find(c => c.id === id)?.label ?? id;

  return (
    <Modal title={editing ? "Edit group" : "New group"} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={e => setName(e.target.value)} required maxLength={64} autoFocus />
          <small className="hint">Client keys reference groups by this name.</small>
        </label>
        <label>
          Description (optional)
          <input value={description} onChange={e => setDescription(e.target.value)} maxLength={256} placeholder="e.g. free-tier keys, fast keys…" />
        </label>

        <fieldset>
          <legend>Routing</legend>
          <label>
            Strategy
            <select value={routingStrategy} onChange={e => setRoutingStrategy(e.target.value as Group["routingStrategy"])}>
              {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label>
            Fallback strategy (used for later attempts after a failure)
            <select
              value={fallbackStrategy ?? ""}
              onChange={e => setFallbackStrategy(e.target.value === "" ? null : e.target.value as Group["routingStrategy"])}
            >
              <option value="">Same as strategy</option>
              {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>Targets ({pairs.length}) — key × model combinations</legend>
          {state.credentials.length === 0 ? (
            <p className="hint">Add a provider credential first.</p>
          ) : (
            <div className="actions">
              <select value={credentialId} onChange={e => { setCredentialId(e.target.value); setModelId(""); }}>
                {state.credentials.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <select value={modelId} onChange={e => setModelId(e.target.value)}>
                <option value="" disabled>Choose model…</option>
                {credentialModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <button type="button" className="btn" disabled={!modelId} onClick={addPair}>Add target</button>
            </div>
          )}
          {pairs.length === 0 ? (
            <p className="hint">No targets yet. A group needs at least one key × model combination.</p>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Provider key</th><th>Model</th><th /></tr></thead>
              <tbody>
                {pairs.map((p, i) => {
                  const stale = isStale(p);
                  return (
                    <tr key={`${p.credentialId}:${p.modelId}`} className={stale ? "row-stale" : ""}>
                      <td>
                        {labelFor(p.credentialId)}
                        {stale && <span className="pill pill-error" title="This credential no longer selects this model">stale</span>}
                      </td>
                      <td><code>{p.modelId}</code></td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setPairs(pairs.filter((_, idx) => idx !== i))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
          {stalePairs.length > 0 && (
            <p className="hint">
              {stalePairs.length} target{stalePairs.length > 1 ? "s" : ""} reference models the credential no longer selects — they will be removed when you save.
            </p>
          )}
        </fieldset>

        <button className="btn btn-primary" disabled={busy || !name.trim() || pairs.length === 0}>
          {busy ? "Saving…" : editing ? "Save changes" : "Create group"}
        </button>
      </form>
    </Modal>
  );
}

export function GroupsPage({ state, reload }: { state: AdminState; reload: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const { toast } = useApp();

  const remove = async (id: string) => {
    try {
      await api.deleteGroup(id);
      toast("info", "Group deleted");
      await reload();
    } catch (e) {
      toast("error", String((e as Error).message));
    }
  };

  return (
    <>
      <section className="page">
        <div className="page-header">
          <h1>Groups</h1>
          <div className="actions">
            <button className="btn btn-primary" disabled={state.credentials.length === 0} onClick={() => setShowModal(true)}>
              New group
            </button>
          </div>
        </div>
        <p className="hint">
          A group routes over explicit key × model targets and defines how requests rotate between them.
          Assign groups to client keys; assigned plain models use basic least-used rotation instead.
        </p>
      </section>

      {state.groups.length === 0 ? (
        <section className="page">
          <div className="empty-state">No groups yet — create one to route key × model targets.</div>
        </section>
      ) : (
        <section className="page">
        <div className="table-wrap cards"><table className="table">
          <thead>
            <tr><th>Name</th><th>Description</th><th>Strategy</th><th>Fallback</th><th>Targets</th><th /></tr>
          </thead>
          <tbody>
            {state.groups.map(g => (
              <tr key={g.id}>
                <td data-label="Name"><strong>{g.name}</strong></td>
                <td data-label="Description">{g.description || "—"}</td>
                <td data-label="Strategy"><span className="pill pill-idle">{g.routingStrategy}</span></td>
                <td data-label="Fallback">{g.fallbackStrategy ?? "same"}</td>
                <td data-label="Targets" className="num">{g.pairs.length}</td>
                <td className="cell-actions">
                  <button className="btn btn-ghost" onClick={() => setEditing(g)}>Edit</button>
                  <ConfirmButton
                    prompt="Delete"
                    warning="Client keys assigned to this group lose its permissions immediately."
                    onConfirm={() => remove(g.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        </section>
      )}

      {(showModal || editing) && (
        <GroupModal
          editing={editing}
          state={state}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { void reload(); }}
        />
      )}
    </>
  );
}
