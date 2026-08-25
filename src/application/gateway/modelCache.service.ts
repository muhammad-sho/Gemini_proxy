import type { ProviderCredentialRepository } from "../../infrastructure/db/repositories/providerCredentials.js";
import type { ModelCacheRepository } from "../../infrastructure/db/repositories/modelCache.js";
import { GeminiAdapter } from "../../infrastructure/providers/gemini.adapter.js";
import { OpenAICompatibleAdapter } from "../../infrastructure/providers/openai-compatible.adapter.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { SettingsService } from "../../domain/settings/settingsService.js";

export class ModelCacheService {
  constructor(
    private credentialRepo: ProviderCredentialRepository,
    private cacheRepo: ModelCacheRepository,
    private logger: Logger,
    private gemini: GeminiAdapter,
    private openai: OpenAICompatibleAdapter,
    private settings: SettingsService
  ) {}

  /**
   * Fire-and-forget refresh when any credential's cache entry is older than
   * the configured TTL (or missing entirely). Never throws.
   */
  maybeRefresh(): void {
    try {
      const ttlHours = this.settings.all().modelsCacheTtlHours;
      const stale = this.credentialRepo.findAll().some(c => !this.cacheRepo.isFresh(c.id, ttlHours));
      if (!stale) return;
      void this.refresh().catch(() => { /* per-credential errors already logged */ });
    } catch (err) {
      this.logger.warn({ err }, "model cache staleness check failed");
    }
  }

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
