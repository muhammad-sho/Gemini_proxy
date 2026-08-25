import { z } from "zod";
import type { EnvConfig } from "./types.js";

export type { EnvConfig };

export const envSchema = z.object({
  GEMINI_PORT: z.coerce.number().int().positive().default(18770),
  OPENAI_PORT: z.coerce.number().int().positive().default(18771),
  ADMIN_PORT: z.coerce.number().int().positive().default(18765),
  GATEWAY_HOST: z.string().default("0.0.0.0"),
  ADMIN_HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform(v => v === "true" || v === "1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional()
});

export function validateEnv(env: Record<string, string | undefined>): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${errors}`);
  }
  const d = result.data;
  return {
    geminiPort: d.GEMINI_PORT,
    openaiPort: d.OPENAI_PORT,
    adminPort: d.ADMIN_PORT,
    gatewayHost: d.GATEWAY_HOST,
    adminHost: d.ADMIN_HOST,
    trustProxy: d.TRUST_PROXY,
    nodeEnv: d.NODE_ENV,
    logLevel: d.LOG_LEVEL
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

export const providerCredentialUpdateSchema = z.object({
  label: z.string().min(1).max(128).optional(),
  baseUrl: z.string().url().optional(),
  allowedModels: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional()
});

export type ProviderCredentialUpdate = z.infer<typeof providerCredentialUpdateSchema>;

const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.null()]).optional(),
  name: z.string().optional()
});

export const chatCompletionCreateSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional()
});

export type ChatCompletionCreate = z.infer<typeof chatCompletionCreateSchema>;
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
}

// ---- Groups and routing strategies ----

export const routingStrategySchema = z.enum(["round_robin", "least_used", "fastest", "smartest"]);
export type RoutingStrategyInput = z.infer<typeof routingStrategySchema>;

const groupPairSchema = z.object({
  credentialId: z.string().min(1),
  modelId: z.string().min(1)
});

export const groupCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
  routingStrategy: routingStrategySchema.default("least_used"),
  fallbackStrategy: routingStrategySchema.nullish(),
  pairs: z.array(groupPairSchema).default([])
});

export const groupUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(256).optional(),
  routingStrategy: routingStrategySchema.optional(),
  fallbackStrategy: routingStrategySchema.nullish(),
  pairs: z.array(groupPairSchema).optional()
});

export const clientKeyUpdateSchema = z.object({
  label: z.string().min(1).max(128).optional(),
  allowedModels: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional()
});

export const providerProbeSchema = z.object({
  provider: z.enum(["gemini", "openai_compatible"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional()
});

export type GroupCreate = z.infer<typeof groupCreateSchema>;
export type GroupUpdate = z.infer<typeof groupUpdateSchema>;
export type ClientKeyUpdate = z.infer<typeof clientKeyUpdateSchema>;
export type ProviderProbe = z.infer<typeof providerProbeSchema>;