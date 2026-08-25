import {
  type ProviderAdapter,
  type UpstreamCredential,
  type ProviderModel,
  type GenerateRequest,
  type GenerateResponse,
  classifyUpstreamError
} from "../../domain/providers/adapter.js";
import { MAX_LIST_RESPONSE_BYTES } from "../../shared/constants.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export class GeminiAdapter implements ProviderAdapter {
  readonly providerType = "gemini" as const;

  baseUrlFor(credential: UpstreamCredential): string {
    return credential.baseUrl || DEFAULT_BASE_URL;
  }

  async listModels(credential: UpstreamCredential): Promise<ProviderModel[]> {
    const baseUrl = this.baseUrlFor(credential);
    const models: ProviderModel[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      const url = new URL(`${baseUrl}/v1beta/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, {
        headers: { "x-goog-api-key": credential.apiKey },
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini listModels failed (${response.status}): ${body.slice(0, 500)}`);
      }

      const raw = await response.text();
      if (raw.length > MAX_LIST_RESPONSE_BYTES) {
        throw new Error(`Gemini listModels response too large (${raw.length} bytes)`);
      }
      const data = JSON.parse(raw) as {
        models?: Array<{
          name: string;
          displayName?: string;
          description?: string;
          supportedGenerationMethods?: string[];
          inputTokenLimit?: number;
          outputTokenLimit?: number;
        }>;
        nextPageToken?: string;
      };

      for (const model of data.models ?? []) {
        const modelId = model.name.replace(/^models\//, "");
        models.push({
          id: modelId,
          name: model.name,
          displayName: model.displayName ?? modelId,
          capabilities: {
            supportedGenerationMethods: model.supportedGenerationMethods ?? [],
            inputTokenLimit: model.inputTokenLimit,
            outputTokenLimit: model.outputTokenLimit
          }
        });
      }

      pageToken = data.nextPageToken;
      pageCount++;
    } while (pageToken && pageCount < 10);

    return models;
  }

  buildUrl(credential: UpstreamCredential, path: string): string {
    return `${this.baseUrlFor(credential)}${path}`;
  }

  buildHeaders(credential: UpstreamCredential): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-goog-api-key": credential.apiKey
    };
  }

  transformRequest(request: GenerateRequest): unknown {
    return request;
  }

  transformResponse(response: unknown): GenerateResponse {
    return response as GenerateResponse;
  }

  classifyError(body: unknown, statusCode: number): ReturnType<typeof classifyUpstreamError> {
    return classifyUpstreamError(statusCode, body, "gemini");
  }
}
