import { validateEnv, type EnvConfig } from "../shared/validation.js";

let cachedConfig: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const env = {
    GEMINI_PORT: process.env.GEMINI_PORT,
    OPENAI_PORT: process.env.OPENAI_PORT,
    ADMIN_PORT: process.env.ADMIN_PORT,
    GATEWAY_HOST: process.env.GATEWAY_HOST,
    ADMIN_HOST: process.env.ADMIN_HOST,
    DB_PATH: process.env.DB_PATH,
    SETUP_TOKEN: process.env.SETUP_TOKEN,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    KEY_FALLBACK_ATTEMPTS: process.env.KEY_FALLBACK_ATTEMPTS,
    KEY_LOOP_DEADLINE_MS: process.env.KEY_LOOP_DEADLINE_MS,
    MODELS_CACHE_TTL_HOURS: process.env.MODELS_CACHE_TTL_HOURS,
    LOG_BODY_MAX_BYTES: process.env.LOG_BODY_MAX_BYTES,
    MAX_LOG_ENTRIES: process.env.MAX_LOG_ENTRIES,
    REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS,
    MAX_BODY_BYTES: process.env.MAX_BODY_BYTES,
    MAX_RESPONSE_BYTES: process.env.MAX_RESPONSE_BYTES,
    TRUST_PROXY: process.env.TRUST_PROXY,
    NODE_ENV: process.env.NODE_ENV
  };

  cachedConfig = validateEnv(env);
  return cachedConfig;
}

export function getConfig(): EnvConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}