import type { ProviderCredentialRepository } from "../../infrastructure/db/repositories/providerCredentials.js";
import type { ModelCacheRepository } from "../../infrastructure/db/repositories/modelCache.js";
import { GeminiAdapter } from "../../infrastructure/providers/gemini.adapter.js";
import { OpenAICompatibleAdapter } from "../../infrastructure/providers/openai-compatible.adapter.js";
import type { Logger } from "../../infrastructure/logging/logger.js";

export class ModelCacheService {
  constructor(
    private credentialRepo: ProviderCredentialRepository,
    private cacheRepo: ModelCacheRepository,
    private logger: Logger,
    private gemini: GeminiAdapter,
    private openai: OpenAICompatibleAdapter
  ) {}

  async refresh(providerId?: string): Promise<{ refreshed: number; errors: string[] }> {
    const credentials = this.credentialRepo.findAllWithKeys();
    const targets = providerId ? credentials.filter(c => c.id === providerId) : credentials;
    const errors: string[] = [];
    let refreshed = 0;

    for (const credential of targets) {
      const adapter = credential.provider === "gemini" ? this.gemini : this.openai;
      const upstream = {
        id: credential.id,
        provider: credential.provider,
        apiKey: credential.apiKey,
        baseUrl: credential.base_url
      };
      try {
        const models = await adapter.listModels(upstream);
        this.cacheRepo.setMany(
          models.map(m => ({
            providerId: credential.id,
            modelId: m.id,
            rawData: JSON.stringify(m)
          }))
        );
        refreshed += models.length;
      } catch (err: any) {
        const msg = `${credential.label}: ${String(err?.message ?? err).slice(0, 200)}`;
        errors.push(msg);
        this.logger.warn({ err }, "model refresh failed for credential");
      }
    }

    return { refreshed, errors };
  }
}
