import { getDb } from "../connection.js";

export type CredentialState = "ready" | "cooling" | "disabled";

export interface ModelCredentialState {
  model_id: string;
  credential_id: string;
  state: CredentialState;
  cooldown_until: number | null;
  cooldown_reason: string | null;
  last_used_at: number | null;
  use_count: number;
  error_count: number;
  last_error_at: number | null;
  last_error_message: string | null;
}

export class ModelCredentialStateRepository {
  private db = getDb();

  private stmtGet = this.db.prepare("SELECT * FROM model_credential_state WHERE model_id = ? AND credential_id = ?");
  private stmtGetByModel = this.db.prepare("SELECT * FROM model_credential_state WHERE model_id = ?");
  private stmtGetByCredential = this.db.prepare("SELECT * FROM model_credential_state WHERE credential_id = ?");
  private stmtGetAllReady = this.db.prepare(`
    SELECT * FROM model_credential_state
    WHERE model_id = ? AND state = 'ready'
    ORDER BY use_count ASC, last_used_at ASC
  `);
  private stmtGetAllCooling = this.db.prepare(`
    SELECT * FROM model_credential_state
    WHERE model_id = ? AND state = 'cooling' AND cooldown_until IS NOT NULL
    ORDER BY cooldown_until ASC
  `);
  private stmtUpsert = this.db.prepare(`
    INSERT INTO model_credential_state (model_id, credential_id, state, cooldown_until, cooldown_reason, last_used_at, use_count, error_count, last_error_at, last_error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id, credential_id) DO UPDATE SET
      state = excluded.state,
      cooldown_until = excluded.cooldown_until,
      cooldown_reason = excluded.cooldown_reason,
      last_used_at = excluded.last_used_at,
      use_count = excluded.use_count,
      error_count = excluded.error_count,
      last_error_at = excluded.last_error_at,
      last_error_message = excluded.last_error_message
  `);
  private stmtUpdateState = this.db.prepare(`
    INSERT INTO model_credential_state (model_id, credential_id, state, cooldown_until, cooldown_reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(model_id, credential_id) DO UPDATE SET
      state = excluded.state,
      cooldown_until = excluded.cooldown_until,
      cooldown_reason = excluded.cooldown_reason
  `);
  private stmtIncrementUse = this.db.prepare(`
    INSERT INTO model_credential_state (model_id, credential_id, state, last_used_at, use_count)
    VALUES (?, ?, 'ready', ?, 1)
    ON CONFLICT(model_id, credential_id) DO UPDATE SET
      use_count = use_count + 1,
      last_used_at = excluded.last_used_at
  `);
  private stmtIncrementError = this.db.prepare(`
    INSERT INTO model_credential_state (model_id, credential_id, state, last_error_at, last_error_message, error_count)
    VALUES (?, ?, 'ready', ?, ?, 1)
    ON CONFLICT(model_id, credential_id) DO UPDATE SET
      error_count = error_count + 1,
      last_error_at = excluded.last_error_at,
      last_error_message = excluded.last_error_message
  `);
  private stmtClearCooldowns = this.db.prepare(`
    UPDATE model_credential_state
    SET state = 'ready', cooldown_until = NULL, cooldown_reason = NULL
    WHERE state = 'cooling'
  `);

  get(modelId: string, credentialId: string): ModelCredentialState | undefined {
    return this.stmtGet.get(modelId, credentialId) as ModelCredentialState | undefined;
  }

  getByModel(modelId: string): ModelCredentialState[] {
    return this.stmtGetByModel.all(modelId) as ModelCredentialState[];
  }

  getByCredential(credentialId: string): ModelCredentialState[] {
    return this.stmtGetByCredential.all(credentialId) as ModelCredentialState[];
  }

  getReadyForModel(modelId: string): ModelCredentialState[] {
    return this.stmtGetAllReady.all(modelId) as ModelCredentialState[];
  }

  getCoolingForModel(modelId: string): ModelCredentialState[] {
    return this.stmtGetAllCooling.all(modelId) as ModelCredentialState[];
  }

  upsert(state: ModelCredentialState): void {
    this.stmtUpsert.run(
      state.model_id,
      state.credential_id,
      state.state,
      state.cooldown_until,
      state.cooldown_reason,
      state.last_used_at,
      state.use_count,
      state.error_count,
      state.last_error_at,
      state.last_error_message
    );
  }

  updateState(modelId: string, credentialId: string, state: CredentialState, cooldownUntil: number | null, reason: string | null): void {
    this.stmtUpdateState.run(modelId, credentialId, state, cooldownUntil, reason);
  }

  incrementUse(modelId: string, credentialId: string): void {
    this.stmtIncrementUse.run(modelId, credentialId, Date.now());
  }

  incrementError(modelId: string, credentialId: string, message: string): void {
    this.stmtIncrementError.run(modelId, credentialId, Date.now(), message);
  }

  clearAllCooldowns(): number {
    const result = this.stmtClearCooldowns.run();
    return result.changes;
  }

  ensureExists(modelId: string, credentialId: string): void {
    const existing = this.get(modelId, credentialId);
    if (!existing) {
      this.upsert({
        model_id: modelId,
        credential_id: credentialId,
        state: "ready",
        cooldown_until: null,
        cooldown_reason: null,
        last_used_at: null,
        use_count: 0,
        error_count: 0,
        last_error_at: null,
        last_error_message: null
      });
    }
  }
}