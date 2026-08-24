import { loadConfig } from "./config/env.js";
import { getDb, runMigrations, closeDb } from "./infrastructure/db/connection.js";
import { buildServer } from "./http/server.js";
import { createLogger } from "./infrastructure/logging/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.nodeEnv);

  logger.info({ version: "1.0.0", nodeEnv: config.nodeEnv }, "Starting Gemini Proxy");

  try {
    const db = getDb();
    runMigrations(db);
    logger.info("Database migrations applied");

    const server = await buildServer(config, logger, db);

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);
      await server.close();
      closeDb();
      logger.info("Shutdown complete");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await server.listen({ port: config.port, host: "0.0.0.0" });
    logger.info(`Server listening on port ${config.port}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

main();