import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AppDeps } from "../server.js";
import { requireAdmin, recordAudit } from "./auth.routes.js";
import {
  clientKeyCreateSchema,
  clientKeyUpdateSchema,
  groupCreateSchema,
  groupUpdateSchema,
  providerCredentialCreateSchema,
  providerCredentialUpdateSchema,
  providerProbeSchema
} from "../../shared/validation.js";
import { settingsUpdateSchema } from "./../../domain/settings/settingsService.js";
import { deriveModelCatalog, derivePairs } from "../../application/gateway/catalog.js";
import { errMessage } from "../../shared/errors.js";

const OUTCOMES = ["success", "error", "timeout", "aborted", "no_keys"] as const;
type Outcome = (typeof OUTCOMES)[number];
function isOutcome(value: string | undefined): value is Outcome {
  return OUTCOMES.includes(value as Outcome);
}

function guard(deps: AppDeps, req: FastifyRequest): boolean {
  return requireAdmin(deps)(req) !== null;
}

export function adminRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", async (req, reply) => {
      if (!guard(deps, req)) {
        return reply.status(401).send({
          error: { code: 401, message: "Unauthorized", requestId: req.id }
        });
      }
    });

    // ---- State overview ----
    app.get("/state", async () => {
      const credentials = deps.providerCredentialRepo.findAll();
      const clientKeys = deps.clientKeyRepo.findAll().map(k => ({
        id: k.id, label: k.label, allowedModels: k.allowed_models,
        allowedGroups: k.allowed_groups, createdAt: k.created_at
      }));
      const cooling = deps.db.prepare(
        "SELECT model_id, credential_id, cooldown_until, cooldown_reason FROM model_credential_state WHERE state = 'cooling' AND cooldown_until > ?"
      ).all(Date.now());

      return {
        credentials: credentials.map(c => ({
          id: c.id, label: c.label, provider: c.provider, baseUrl: c.base_url,
          allowedModels: c.allowed_models, createdAt: c.created_at
        })),
        models: deriveModelCatalog(credentials),
        pairs: derivePairs(credentials),
        groups: deps.groupRepo.list(),
        clientKeys,
        cooling
      };
    });

    // ---- Usage metrics (SQL-aggregated over a time window) ----
    app.get("/usage-summary", async (req) => {
      const q = req.query as { days?: string };
      const days = q.days === "7" ? 7 : 1;
      const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
      return {
        days,
        models: deps.usageRepo.aggregateByModel(sinceSec),
        generatedAt: Math.floor(Date.now() / 1000)
      };
    });

    // ---- Live provider model probing (never persisted) ----

    // For the add form: probe with the key being typed.
    app.post("/provider-models/probe", async (req, reply) => {
      const parsed = providerProbeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      try {
        const models = await deps.probeService.probe(parsed.data);
        return { models: models.map(m => ({ id: m.id, displayName: m.displayName })) };
      } catch (err) {
        return reply.status(502).send({
          error: { code: 502, message: errMessage(err).slice(0, 300), requestId: req.id }
        });
      }
    });

    // For the edit form: probe again with the stored (decrypted) key.
    app.get("/provider-credentials/:id/models", async (req, reply) => {
      const { id } = req.params as { id: string };
      const credential = deps.providerCredentialRepo.findAllWithKeys().find(c => c.id === id);
      if (!credential) {
        return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      }
      try {
        const models = await deps.probeService.probeCredential(credential);
        return { models: models.map(m => ({ id: m.id, displayName: m.displayName })) };
      } catch (err) {
        return reply.status(502).send({
          error: { code: 502, message: errMessage(err).slice(0, 300), requestId: req.id }
        });
      }
    });

    // ---- Provider credentials ----
    app.post("/provider-credentials", async (req, reply) => {
      const parsed = providerCredentialCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      try {
        const created = deps.providerCredentialRepo.create(
          parsed.data.label,
          parsed.data.provider,
          parsed.data.apiKey,
          parsed.data.baseUrl ?? null,
          parsed.data.allowedModels ?? [],
          parsed.data.allowedGroups ?? []
        );
        recordAudit(deps, null, "create", "provider_credential", created.id, req.ip);
        return reply.status(201).send({ id: created.id });
      } catch (err) {
        return reply.status(500).send({ error: { code: 500, message: errMessage(err), requestId: req.id } });
      }
    });

    app.delete("/provider-credentials/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!deps.providerCredentialRepo.findById(id)) {
        return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      }
      // Integrity cascade: drop the credential's group targets atomically.
      deps.db.transaction(() => {
        deps.providerCredentialRepo.delete(id);
        deps.groupRepo.removeCredentialTargets(id);
      })();
      recordAudit(deps, null, "delete", "provider_credential", id, req.ip);
      return { ok: true };
    });

    app.put("/provider-credentials/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = providerCredentialUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      const existing = deps.providerCredentialRepo.findById(id);
      if (!existing) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });

      const updated = deps.providerCredentialRepo.update(id, {
        label: parsed.data.label,
        base_url: parsed.data.baseUrl,
        allowed_models: parsed.data.allowedModels,
        allowed_groups: parsed.data.allowedGroups
      });
      if (!updated) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });

      recordAudit(deps, null, "update", "provider_credential", id, req.ip);
      return { ok: true };
    });

    // ---- Groups (routing scopes over credential×model pairs) ----

    app.get("/groups", async () => deps.groupRepo.list());

    app.post("/groups", async (req, reply) => {
      const parsed = groupCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      try {
        const created = deps.groupRepo.create(parsed.data);
        recordAudit(deps, null, "create", "group", created.id, req.ip);
        return reply.status(201).send(created);
      } catch (err) {
        const message = errMessage(err);
        if (message.includes("UNIQUE")) {
          return reply.status(409).send({ error: { code: 409, message: "A group with this name already exists", requestId: req.id } });
        }
        return reply.status(500).send({ error: { code: 500, message, requestId: req.id } });
      }
    });

    app.put("/groups/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = groupUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      const existing = deps.groupRepo.get(id);
      if (!existing) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      let updated;
      try {
        updated = deps.groupRepo.update(id, parsed.data);
      } catch (err) {
        const message = errMessage(err);
        if (message.includes("UNIQUE")) {
          return reply.status(409).send({ error: { code: 409, message: "A group with this name already exists", requestId: req.id } });
        }
        return reply.status(500).send({ error: { code: 500, message, requestId: req.id } });
      }
      // Integrity cascade: keep client-key references pointing at the new name.
      if (parsed.data.name && parsed.data.name !== existing.name) {
        deps.clientKeyRepo.renameGroupRef(existing.name, parsed.data.name);
      }
      recordAudit(deps, null, "update", "group", id, req.ip);
      return updated;
    });

    app.delete("/groups/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = deps.groupRepo.get(id);
      if (!existing) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      // Integrity cascade: remove dangling permissions before deleting.
      deps.clientKeyRepo.removeGroupRef(existing.name);
      deps.groupRepo.delete(id);
      recordAudit(deps, null, "delete", "group", id, req.ip);
      return { ok: true };
    });

    // ---- Client keys ----
    app.post("/client-keys", async (req, reply) => {
      const parsed = clientKeyCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      const created = deps.clientKeyRepo.create(parsed.data.label, parsed.data.allowedModels ?? [], parsed.data.allowedGroups ?? []);
      recordAudit(deps, null, "create", "client_key", created.id, req.ip);
      return reply.status(201).send({ id: created.id, clientApiKey: created.clientApiKey });
    });

    app.put("/client-keys/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = clientKeyUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id } });
      }
      const existing = deps.clientKeyRepo.findById(id);
      if (!existing) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      deps.clientKeyRepo.update(id, {
        label: parsed.data.label ?? existing.label,
        allowed_models: parsed.data.allowedModels ?? existing.allowed_models,
        allowed_groups: parsed.data.allowedGroups ?? existing.allowed_groups
      });
      recordAudit(deps, null, "update", "client_key", id, req.ip);
      return { ok: true };
    });

    app.delete("/client-keys/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = deps.clientKeyRepo.delete(id);
      if (!ok) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      recordAudit(deps, null, "delete", "client_key", id, req.ip);
      return { ok: true };
    });

    // ---- Logs ----
    app.get("/logs", async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const result = deps.logRepo.findFiltered({
        model: q.model,
        outcome: isOutcome(q.outcome) ? q.outcome : undefined,
        query: q.q,
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
      return {
        total: result.total,
        logs: result.logs.map(l => ({
          id: l.id,
          traceId: l.trace_id,
          modelId: l.model_id,
          method: l.method,
          path: l.path,
          responseStatus: l.response_status,
          latencyMs: l.latency_ms,
          attemptNumber: l.attempt_number,
          totalAttempts: l.total_attempts,
          finalOutcome: l.final_outcome,
          createdAt: l.created_at
        }))
      };
    });

    app.get("/logs/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const log = deps.logRepo.findById(Number(id));
      if (!log) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      let timeline: unknown[] = [];
      try { timeline = JSON.parse(log.timeline); } catch { /* ignore */ }
      return {
        ...log,
        timeline,
        request_headers: undefined,
        request_body: log.request_body,
        response_body: log.response_body
      };
    });

    // ---- Cooldowns clear ----
    app.post("/cooldowns/clear", async () => {
      const cleared = deps.stateRepo.clearAllCooldowns();
      return { cleared };
    });

    // ---- Security log (audit trail) ----
    app.get("/audit-logs", async (req) => {
      const q = req.query as { action?: string; limit?: string; offset?: string };
      const result = deps.auditRepo.findFiltered({
        action: q.action || undefined,
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
      return {
        total: result.total,
        actions: deps.auditRepo.distinctActions(),
        logs: result.logs.map(l => ({
          id: l.id,
          action: l.action,
          entityType: l.entity_type,
          entityId: l.entity_id,
          adminUserId: l.admin_user_id,
          ipAddress: l.ip_address,
          createdAt: l.created_at
        }))
      };
    });

    // ---- Runtime settings (dashboard Settings tab) ----
    app.get("/settings", async () => deps.settings.all());

    app.put("/settings", async (req, reply) => {
      const parsed = settingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: 400, message: parsed.error.errors.map(e => e.message).join("; "), requestId: req.id }
        });
      }
      const updated = deps.settings.update(parsed.data);
      recordAudit(deps, null, "update", "settings", Object.keys(parsed.data).join(","), req.ip);
      return updated;
    });
  };
}
