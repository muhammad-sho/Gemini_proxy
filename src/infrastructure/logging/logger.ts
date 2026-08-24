import pino from "pino";

export function createLogger(nodeEnv: string): pino.Logger {
  const isDevelopment = nodeEnv === "development";

  return pino({
    level: isDevelopment ? "debug" : "info",
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname"
          }
        }
      : undefined,
    formatters: {
      level: (label) => ({ level: label })
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {}
  });
}

export type Logger = pino.Logger;