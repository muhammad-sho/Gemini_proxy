import type { FastifyPluginAsync } from "fastify";
import { getSchemaVersion } from "../../infrastructure/db/connection.js";
import type { AppDeps } from "../server.js";

export function healthRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get("/health/live", async () => ({ status: "ok" }));

    app.get("/health/ready", async (_req, reply) => {
      const checks: Record<string, boolean> = {};
      let ready = true;

      try {
        deps.db.prepare("SELECT 1").get();
        checks.database = true;
      } catch {
        checks.database = false;
        ready = false;
      }

      const version = getSchemaVersion(deps.db);
      checks.schema = version > 0;

      if (deps.config.nodeEnv === "production") {
        checks.encryption = Boolean(process.env.APP_ENCRYPTION_KEY);
        if (!checks.encryption) ready = false;
      }

      if (!ready) {
        return reply.status(503).send({ status: "unavailable", checks });
      }
      return { status: "ready", checks, schemaVersion: version };
    });
  };
}
