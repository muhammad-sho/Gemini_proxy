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
      const usageByModel = deps.usageRepo.getRecent(500).reduce<Record<string, number>>((acc, e) => {
        acc[e.model_id] = (acc[e.model_id] ?? 0) + 1;
        return acc;
      }, {});
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
        usageByModel,
        cooling
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
      } catch (err: any) {
        return reply.status(502).send({
          error: { code: 502, message: String(err?.message ?? err).slice(0, 300), requestId: req.id }
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
      } catch (err: any) {
        return reply.status(502).send({
          error: { code: 502, message: String(err?.message ?? err).slice(0, 300), requestId: req.id }
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
      } catch (err: any) {
        return reply.status(500).send({ error: { code: 500, message: String(err?.message ?? err), requestId: req.id } });
      }
    });

    app.delete("/provider-credentials/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = deps.providerCredentialRepo.delete(id);
      if (!ok) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
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
      } catch (err: any) {
        const message = String(err?.message ?? err);
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
      let updated;
      try {
        updated = deps.groupRepo.update(id, parsed.data);
      } catch (err: any) {
        const message = String(err?.message ?? err);
        if (message.includes("UNIQUE")) {
          return reply.status(409).send({ error: { code: 409, message: "A group with this name already exists", requestId: req.id } });
        }
        return reply.status(500).send({ error: { code: 500, message, requestId: req.id } });
      }
      if (!updated) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
      recordAudit(deps, null, "update", "group", id, req.ip);
      return updated;
    });

    app.delete("/groups/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = deps.groupRepo.delete(id);
      if (!ok) return reply.status(404).send({ error: { code: 404, message: "Not found", requestId: req.id } });
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
        outcome: q.outcome as any,
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
