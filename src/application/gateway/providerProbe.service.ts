import type { ProviderAdapter, ProviderModel } from "../../domain/providers/adapter.js";
import type { GeminiAdapter } from "../../infrastructure/providers/gemini.adapter.js";
import type { OpenAICompatibleAdapter } from "../../infrastructure/providers/openai-compatible.adapter.js";
import type { ProviderCredentialWithSecret } from "../../infrastructure/db/repositories/providerCredentials.js";

/**
 * Live model discovery against an upstream provider. Results are shown in the
 * admin UI while adding/editing a provider key and are never stored — only
 * the models the admin selects get saved on the credential.
 */

/** Hosts that must never be probed: cloud metadata endpoints have no
 *  legitimate provider use. LAN/loopback targets stay allowed — self-hosted
 *  upstreams (LiteLLM, vLLM, …) commonly live there. */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^169\.254\./i,               // link-local (includes 169.254.169.254)
  /^fe80:/i,                    // IPv6 link-local
  /(^|\.)metadata\./i,          // metadata.google.internal & friends
  /\.internal$/i                // RFC 6762 internal zones
];

export function assertNotMetadataTarget(baseUrl: string | null | undefined): void {
  if (!baseUrl) return;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(`Refusing to probe restricted host: ${host}`);
    }
  }
}

export class ProviderProbeService {
  private adapters: Map<string, ProviderAdapter>;

  constructor(gemini: GeminiAdapter, openai: OpenAICompatibleAdapter) {
    this.adapters = new Map<string, ProviderAdapter>([
      ["gemini", gemini],
      ["openai_compatible", openai]
    ]);
  }

  /** Probe with explicitly supplied connection info (add-credential form). */
  async probe(input: {
    provider: "gemini" | "openai_compatible";
    apiKey: string;
    baseUrl?: string | null;
  }): Promise<ProviderModel[]> {
    return this.fetch({ provider: input.provider, apiKey: input.apiKey, baseUrl: input.baseUrl ?? null });
  }

  /** Probe using the stored (decrypted) key of an existing credential. */
  async probeCredential(credential: ProviderCredentialWithSecret): Promise<ProviderModel[]> {
    return this.fetch({
      provider: credential.provider,
      apiKey: credential.apiKey,
      baseUrl: credential.base_url
    });
  }

  private async fetch(credential: {
    provider: "gemini" | "openai_compatible";
    apiKey: string;
    baseUrl: string | null;
  }): Promise<ProviderModel[]> {
    assertNotMetadataTarget(credential.baseUrl);
    const adapter = this.adapters.get(credential.provider);
    if (!adapter) throw new Error(`Unknown provider: ${credential.provider}`);
    return adapter.listModels({
      id: "probe",
      provider: credential.provider,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl
    });
  }
}
