import { z } from "zod";
import type { EnvConfig } from "./types.js";

export type { EnvConfig };

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(18765),
  DB_PATH: z.string().default("./data/gemini-proxy.db"),
  SETUP_TOKEN: z.string().min(1, "SETUP_TOKEN is required"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  KEY_FALLBACK_ATTEMPTS: z.coerce.number().int().positive().default(2),
  KEY_LOOP_DEADLINE_MS: z.coerce.number().int().positive().default(30000),
  MODELS_CACHE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  LOG_BODY_MAX_BYTES: z.coerce.number().int().positive().default(1048576),
  MAX_LOG_ENTRIES: z.coerce.number().int().positive().default(1000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(10485760),
  MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(52428800),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform(v => v === "true" || v === "1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development")
});

export function validateEnv(env: Record<string, string | undefined>): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${errors}`);
  }
  const d = result.data;
  return {
    port: d.PORT,
    dbPath: d.DB_PATH,
    setupToken: d.SETUP_TOKEN,
    encryptionKey: d.APP_ENCRYPTION_KEY,
    keyFallbackAttempts: d.KEY_FALLBACK_ATTEMPTS,
    keyLoopDeadlineMs: d.KEY_LOOP_DEADLINE_MS,
    modelsCacheTtlHours: d.MODELS_CACHE_TTL_HOURS,
    logBodyMaxBytes: d.LOG_BODY_MAX_BYTES,
    maxLogEntries: d.MAX_LOG_ENTRIES,
    requestTimeoutMs: d.REQUEST_TIMEOUT_MS,
    maxBodyBytes: d.MAX_BODY_BYTES,
    maxResponseBytes: d.MAX_RESPONSE_BYTES,
    trustProxy: d.TRUST_PROXY,
    nodeEnv: d.NODE_ENV
  };
}

export const clientKeyCreateSchema = z.object({
  label: z.string().min(1).max(128),
  allowedModels: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional()
});

export const providerCredentialCreateSchema = z.object({
  label: z.string().min(1).max(128),
  provider: z.enum(["gemini", "openai_compatible"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  allowedModels: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional()
});

export type ClientKeyCreate = z.infer<typeof clientKeyCreateSchema>;
export type ProviderCredentialCreate = z.infer<typeof providerCredentialCreateSchema>;