import { loadConfig } from "./config/env.js";
import { getDb, runMigrations, closeDb } from "./infrastructure/db/connection.js";
import { buildServers } from "./http/server.js";
import { createLogger } from "./infrastructure/logging/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.nodeEnv, config.logLevel);

  logger.info(
    {
      version: "1.0.0",
      nodeEnv: config.nodeEnv,
      ports: { gemini: config.geminiPort, openai: config.openaiPort, admin: config.adminPort },
      hosts: { gateway: config.gatewayHost, admin: config.adminHost }
    },
    "Starting Gemini Proxy"
  );

  let shuttingDown = false;
  try {
    const db = getDb();
    runMigrations(db);
    logger.info("Database migrations applied");

    const servers = await buildServers(config, logger, db);

    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully`);
      await Promise.allSettled([
        servers.admin.close(),
        servers.gemini.close(),
        servers.openai.close()
      ]);
      closeDb();
      logger.info("Shutdown complete");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Each surface listens independently so it can be exposed or firewalled
    // on its own; see README "Ports and exposure".
    await Promise.all([
      servers.gemini.listen({ port: config.geminiPort, host: config.gatewayHost }),
      servers.openai.listen({ port: config.openaiPort, host: config.gatewayHost }),
      servers.admin.listen({ port: config.adminPort, host: config.adminHost })
    ]);
    logger.info(
      `Gemini gateway on ${config.gatewayHost}:${config.geminiPort}, ` +
      `OpenAI gateway on ${config.gatewayHost}:${config.openaiPort}, ` +
      `dashboard/admin on ${config.adminHost}:${config.adminPort}`
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

main();
