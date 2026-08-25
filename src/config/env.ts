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
    TRUST_PROXY: process.env.TRUST_PROXY,
    HSTS: process.env.HSTS,
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL
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