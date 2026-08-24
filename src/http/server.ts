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

import { AdminSessionService } from "./../domain/auth/adminSessionService.js";

import { GeminiAdapter } from "./../infrastructure/providers/gemini.adapter.js";
import { OpenAICompatibleAdapter } from "./../infrastructure/providers/openai-compatible.adapter.js";

import { RoutingService } from "./../application/gateway/routing.service.js";
import { ModelCacheService } from "./../application/gateway/modelCache.service.js";

import { healthRoutes } from "./routes/health.routes.js";
import { gatewayRoutes } from "./routes/gateway.routes.js";
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
}

export async function buildServer(config: EnvConfig, logger: Logger, db: Database) {
  const app = Fastify({
    logger: logger as never,
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    requestTimeout: config.requestTimeoutMs,
    genReqId: () => randomUUID()
  });

  await app.register(cookie);
  await app.register(helmet, {
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
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: req => `${req.ip}`
  });

  // ---- Composition root (dependency injection) ----
  const clientKeyRepo = new ClientKeyRepository();
  const providerCredentialRepo = new ProviderCredentialRepository();
  const stateRepo = new ModelCredentialStateRepository();
  const usageRepo = new UsageEventRepository();
  const logRepo = new RequestLogRepository();
  const cacheRepo = new ModelCacheRepository();
  const groupRepo = new ModelGroupRepository();

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
    clientKeyRepo, providerCredentialRepo, stateRepo, usageRepo, logRepo, cacheRepo, groupRepo
  };

  // ---- Routes ----
  await app.register(healthRoutes(deps));
  await app.register(gatewayRoutes(deps));
  await app.register(authRoutes(deps), { prefix: "/api/admin" });
  await app.register(adminRoutes(deps), { prefix: "/api/admin/v1" });

  // ---- Static dashboard (built web/dist-web), SPA fallback ----
  const webRoot = new URL("../../dist-web/", import.meta.url).pathname;
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      // API routes keep their JSON 404; everything else falls back to the SPA.
      if (
        request.raw.url?.startsWith("/api") ||
        request.raw.url?.startsWith("/v1beta") ||
        request.raw.url?.startsWith("/health")
      ) {
        return reply.status(404).send({
          error: { code: 404, message: "Not found", requestId: request.id }
        });
      }
      return reply.sendFile("index.html");
    });
  }

  // Central error handler -> normalized envelope
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const requestId = request.id;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
    }
    reply.status(statusCode).send({
      error: {
        code: statusCode === 429 ? "rate_limited" : statusCode >= 500 ? "internal_error" : "bad_request",
        message: statusCode >= 500 && config.nodeEnv === "production" ? "Internal server error" : error.message,
        requestId
      }
    });
  });

  return app;
}
