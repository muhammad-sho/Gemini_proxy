import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { EnvConfig } from "../shared/validation.js";
import type { Logger } from "../infrastructure/logging/logger.js";
import type { Database } from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync } from "fs";

import { ClientKeyRepository } from "./../infrastructure/db/repositories/clientKeys.js";
import { ProviderCredentialRepository } from "./../infrastructure/db/repositories/providerCredentials.js";
import { ModelCredentialStateRepository } from "./../infrastructure/db/repositories/modelCredentialState.js";
import { UsageEventRepository } from "./../infrastructure/db/repositories/usageEvents.js";
import { RequestLogRepository } from "./../infrastructure/db/repositories/requestLogs.js";
import { ModelGroupRepository } from "./../infrastructure/db/repositories/modelGroups.js";
import { AuditLogRepository } from "./../infrastructure/db/repositories/auditLogs.js";

import { AdminSessionService } from "./../domain/auth/adminSessionService.js";
import { SettingsService } from "./../domain/settings/settingsService.js";

import { GeminiAdapter } from "./../infrastructure/providers/gemini.adapter.js";
import { OpenAICompatibleAdapter } from "./../infrastructure/providers/openai-compatible.adapter.js";

import { RoutingService } from "./../application/gateway/routing.service.js";
import { ProviderProbeService } from "./../application/gateway/providerProbe.service.js";

import { healthRoutes } from "./routes/health.routes.js";
import { gatewayRoutes } from "./routes/gateway.routes.js";
import { openaiRoutes } from "./routes/openai.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { BODY_LIMIT_BYTES, FASTIFY_REQUEST_TIMEOUT_MS } from "../shared/constants.js";

export interface AppDeps {
  config: EnvConfig;
  logger: Logger;
  db: Database;
  settings: SettingsService;
  routingService: RoutingService;
  probeService: ProviderProbeService;
  adminSessionService: AdminSessionService;
  clientKeyRepo: ClientKeyRepository;
  providerCredentialRepo: ProviderCredentialRepository;
  stateRepo: ModelCredentialStateRepository;
  usageRepo: UsageEventRepository;
  logRepo: RequestLogRepository;
  groupRepo: ModelGroupRepository;
  auditRepo: AuditLogRepository;
}

export interface AppServers {
  /** Dashboard + admin API. Bind local-only by default (ADMIN_HOST). */
  admin: AppInstance;
  /** Gemini-protocol gateway (/v1beta/*). */
  gemini: AppInstance;
  /** OpenAI-protocol gateway (/v1/models, /v1/chat/completions). */
  openai: AppInstance;
}

/** Instance shape produced by newApp (kept inferred to satisfy Fastify's plugin generics). */
type AppInstance = ReturnType<typeof newApp>;

function newApp(config: EnvConfig, logger: Logger) {
  return Fastify({
    logger: logger as never,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: config.trustProxy,
    requestTimeout: FASTIFY_REQUEST_TIMEOUT_MS,
    genReqId: () => randomUUID()
  });
}

/** Normalized error envelope with a numeric HTTP-aligned code on every surface. */
function installErrorHandler(app: AppInstance, config: EnvConfig): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
    }
    reply.status(statusCode).send({
      error: {
        code: statusCode,
        message: statusCode >= 500 && config.nodeEnv === "production" ? "Internal server error" : error.message,
        requestId: request.id
      }
    });
  });
}

async function registerRateLimit(app: AppInstance, maxPerMinute: number): Promise<void> {
  await app.register(rateLimit, {
    max: maxPerMinute,
    timeWindow: "1 minute",
    keyGenerator: req => `${req.ip}`
  });
}

function jsonNotFound(app: AppInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 404, message: "Not found", requestId: request.id }
    });
  });
}

/**
 * Composition root: constructs the shared services once and exposes three
 * independent HTTP servers so each surface can be exposed or firewalled on
 * its own.
 */
export async function buildServers(config: EnvConfig, logger: Logger, db: Database): Promise<AppServers> {
  // ---- Shared composition (dependency injection) ----
  const clientKeyRepo = new ClientKeyRepository();
  const providerCredentialRepo = new ProviderCredentialRepository();
  const stateRepo = new ModelCredentialStateRepository();
  const usageRepo = new UsageEventRepository();
  const logRepo = new RequestLogRepository();
  const groupRepo = new ModelGroupRepository();
  const auditRepo = new AuditLogRepository();

  const adminSessionService = new AdminSessionService();

  // Runtime-tunable settings (dashboard Settings tab), persisted in app_metadata.
  const settings = new SettingsService();
  settings.init(db);

  const geminiAdapter = new GeminiAdapter();
  const openaiAdapter = new OpenAICompatibleAdapter();

  const routingService = new RoutingService(
    providerCredentialRepo, stateRepo, usageRepo, logRepo, logger, geminiAdapter, openaiAdapter, settings
  );
  const probeService = new ProviderProbeService(geminiAdapter, openaiAdapter);

  const deps: AppDeps = {
    config, logger, db, settings,
    routingService, probeService, adminSessionService,
    clientKeyRepo, providerCredentialRepo, stateRepo, usageRepo, logRepo, groupRepo, auditRepo
  };

  // ---- Admin/dashboard server ----
  const admin = newApp(config, logger);
  await admin.register(cookie);
  await admin.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        // Served over plain HTTP on LAN; upgrading to https:// breaks asset loading.
        upgradeInsecureRequests: null
      }
    },
    // Strict-Transport-Security is opt-in via HSTS=true — sending it over
    // plain HTTP can make browsers refuse future unencrypted visits.
    hsts: config.hsts
      ? { maxAge: 15552000 }
      : false
  });
  // Boot-time snapshot of settings.rateLimitPerMinute (restart to apply changes).
  const globalRateLimit = settings.all().rateLimitPerMinute;
  await registerRateLimit(admin, globalRateLimit);

  await admin.register(healthRoutes(deps));
  await admin.register(authRoutes(deps), { prefix: "/api/admin/v1" });
  await admin.register(adminRoutes(deps), { prefix: "/api/admin/v1" });

  // Static dashboard (built web/dist-web), SPA fallback
  const webRoot = new URL("../../dist-web/", import.meta.url).pathname;
  if (existsSync(webRoot)) {
    await admin.register(fastifyStatic, { root: webRoot });
    admin.setNotFoundHandler((request, reply) => {
      // Admin API and health keep their JSON 404; everything else falls back to the SPA.
      if (
        request.raw.url?.startsWith("/api") ||
        request.raw.url?.startsWith("/health")
      ) {
        return reply.status(404).send({
          error: { code: 404, message: "Not found", requestId: request.id }
        });
      }
      return reply.sendFile("index.html");
    });
  }
  installErrorHandler(admin, config);

  // ---- Gemini-protocol gateway ----
  const gemini = newApp(config, logger);
  await gemini.register(helmet, { contentSecurityPolicy: false });
  await registerRateLimit(gemini, globalRateLimit);
  await gemini.register(gatewayRoutes(deps));
  jsonNotFound(gemini);
  installErrorHandler(gemini, config);

  // ---- OpenAI-protocol gateway ----
  const openai = newApp(config, logger);
  await openai.register(helmet, { contentSecurityPolicy: false });
  await registerRateLimit(openai, globalRateLimit);
  await openai.register(openaiRoutes(deps));
  jsonNotFound(openai);
  installErrorHandler(openai, config);

  return { admin, gemini, openai };
}
