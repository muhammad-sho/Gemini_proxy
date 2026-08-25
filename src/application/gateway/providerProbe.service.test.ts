import { describe, it, expect } from "vitest";
import { assertNotMetadataTarget } from "./providerProbe.service.js";

describe("assertNotMetadataTarget", () => {
  it("blocks cloud metadata and link-local targets", () => {
    for (const url of [
      "http://169.254.169.254/v1/models",
      "http://169.254.169.254",
      "http://metadata.google.internal/computeMetadata",
      "https://foo.metadata.internal/v1"
    ]) {
      expect(() => assertNotMetadataTarget(url), url).toThrow(/restricted host|Invalid base URL/);
    }
  });

  it("allows real providers and self-hosted LAN upstreams", () => {
    for (const url of [
      null,
      "https://generativelanguage.googleapis.com",
      "https://api.openai.com",
      "http://192.168.1.10:8000",   // LAN LiteLLM / vLLM
      "http://127.0.0.1:8080"       // local upstream
    ]) {
      expect(() => assertNotMetadataTarget(url), String(url)).not.toThrow();
    }
  });

  it("rejects unparseable URLs", () => {
    expect(() => assertNotMetadataTarget("not a url")).toThrow(/Invalid base URL/);
  });
});
