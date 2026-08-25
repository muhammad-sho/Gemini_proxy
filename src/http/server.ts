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
import { ModelCacheRepository } from "./../infrastructure/db/repositories/modelCache.js";
import { ModelGroupRepository } from "./../infrastructure/db/repositories/modelGroups.js";
import { AuditLogRepository } from "./../infrastructure/db/repositories/auditLogs.js";

import { AdminSessionService } from "./../domain/auth/adminSessionService.js";

import { GeminiAdapter } from "./../infrastructure/providers/gemini.adapter.js";
import { OpenAICompatibleAdapter } from "./../infrastructure/providers/openai-compatible.adapter.js";

import { RoutingService } from "./../application/gateway/routing.service.js";
import { ModelCacheService } from "./../application/gateway/modelCache.service.js";

import { healthRoutes } from "./routes/health.routes.js";
import { gatewayRoutes } from "./routes/gateway.routes.js";
import { openaiRoutes } from "./routes/openai.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";

export interface AppDeps {
  config: EnvConfig;
  logger: Logger;
  db: Database;
  routingService: RoutingService;
  modelCacheService: ModelCacheService;
  adminSessionService: AdminSessionService;
  clientKeyRepo: ClientKeyRepository;
  providerCredentialRepo: ProviderCredentialRepository;
  stateRepo: ModelCredentialStateRepository;
  usageRepo: UsageEventRepository;
  logRepo: RequestLogRepository;
  cacheRepo: ModelCacheRepository;
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
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    requestTimeout: config.requestTimeoutMs,
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

async function registerRateLimit(app: AppInstance): Promise<void> {
  await app.register(rateLimit, {
    max: 300,
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
  const cacheRepo = new ModelCacheRepository();
  const groupRepo = new ModelGroupRepository();
  const auditRepo = new AuditLogRepository();

  const adminSessionService = new AdminSessionService();

  const geminiAdapter = new GeminiAdapter();
  const openaiAdapter = new OpenAICompatibleAdapter();

  const routingService = new RoutingService(
    providerCredentialRepo, stateRepo, usageRepo, logRepo, cacheRepo, logger, geminiAdapter, openaiAdapter
  );
  const modelCacheService = new ModelCacheService(providerCredentialRepo, cacheRepo, logger, geminiAdapter, openaiAdapter);

  const deps: AppDeps = {
    config, logger, db,
    routingService, modelCacheService, adminSessionService,
    clientKeyRepo, providerCredentialRepo, stateRepo, usageRepo, logRepo, cacheRepo, groupRepo, auditRepo
  };

  // ---- Admin/dashboard server ----
  const admin = newApp(config, logger);
  await admin.register(cookie);
  await admin.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        // Served over plain HTTP on LAN; upgrading to https:// breaks asset loading.
        upgradeInsecureRequests: null
      }
    }
  });
  await registerRateLimit(admin);

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
  await registerRateLimit(gemini);
  await gemini.register(gatewayRoutes(deps));
  jsonNotFound(gemini);
  installErrorHandler(gemini, config);

  // ---- OpenAI-protocol gateway ----
  const openai = newApp(config, logger);
  await openai.register(helmet, { contentSecurityPolicy: false });
  await registerRateLimit(openai);
  await openai.register(openaiRoutes(deps));
  jsonNotFound(openai);
  installErrorHandler(openai, config);

  return { admin, gemini, openai };
}
