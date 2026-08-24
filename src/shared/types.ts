export interface EnvConfig {
  port: number;
  dbPath: string;
  setupToken: string;
  encryptionKey?: string;
  keyFallbackAttempts: number;
  keyLoopDeadlineMs: number;
  modelsCacheTtlHours: number;
  logBodyMaxBytes: number;
  maxLogEntries: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  trustProxy: boolean;
  nodeEnv: "development" | "production" | "test";
}

export const envSchema = {
  port: { default: 18765, coerce: true },
  dbPath: { default: "./data/gemini-proxy.db" },
  setupToken: { default: "" },
  encryptionKey: { default: undefined },
  keyFallbackAttempts: { default: 2, coerce: true },
  keyLoopDeadlineMs: { default: 30000, coerce: true },
  modelsCacheTtlHours: { default: 24, coerce: true },
  logBodyMaxBytes: { default: 1048576, coerce: true },
  maxLogEntries: { default: 1000, coerce: true },
  requestTimeoutMs: { default: 60000, coerce: true },
  maxBodyBytes: { default: 10485760, coerce: true },
  maxResponseBytes: { default: 52428800, coerce: true },
  trustProxy: { default: false, coerce: true },
  nodeEnv: { default: "development" }
} as const;