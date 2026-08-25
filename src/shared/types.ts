export interface EnvConfig {
  geminiPort: number;
  openaiPort: number;
  adminPort: number;
  gatewayHost: string;
  adminHost: string;
  trustProxy: boolean;
  nodeEnv: "development" | "production" | "test";
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export const envSchema = {
  geminiPort: { default: 18770, coerce: true },
  openaiPort: { default: 18771, coerce: true },
  adminPort: { default: 18765, coerce: true },
  gatewayHost: { default: "0.0.0.0" },
  adminHost: { default: "127.0.0.1" },
  trustProxy: { default: false, coerce: true },
  nodeEnv: { default: "development" },
  logLevel: { default: undefined }
} as const;
