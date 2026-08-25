import type { ProviderCredential } from "../../infrastructure/db/repositories/providerCredentials.js";

export interface CatalogEntry {
  id: string;
}

export interface CatalogPair {
  credentialId: string;
  credentialLabel: string;
  modelId: string;
}

/**
 * The proxy's model catalog is derived, never stored: a model exists here
 * because at least one active provider credential lists it among its selected
 * models. key1/model1 and key2/model1 are distinct routing targets.
 */
export function deriveModelCatalog(credentials: ProviderCredential[]): CatalogEntry[] {
  const ids = new Set<string>();
  for (const credential of credentials) {
    for (const modelId of credential.allowed_models) ids.add(modelId);
  }
  return [...ids].sort().map(id => ({ id }));
}

/** All live credential×model combinations across active credentials. */
export function derivePairs(credentials: ProviderCredential[]): CatalogPair[] {
  const pairs: CatalogPair[] = [];
  for (const credential of credentials) {
    for (const modelId of credential.allowed_models) {
      pairs.push({ credentialId: credential.id, credentialLabel: credential.label, modelId });
    }
  }
  return pairs;
}
