/**
 * Fixed-window per-client-key rate limiting for the gateway surfaces.
 * Deliberately dependency-free: an in-memory map is enough for the
 * single-node deployments this proxy targets (0 disables the limit).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function allowClientKeyRequest(
  keyId: string,
  limitPerMinute: number,
  nowMs: number = Date.now()
): boolean {
  if (limitPerMinute <= 0) return true;
  const existing = buckets.get(keyId);
  if (!existing || existing.resetAt <= nowMs) {
    buckets.set(keyId, { count: 1, resetAt: nowMs + 60_000 });
    return true;
  }
  if (existing.count < limitPerMinute) {
    existing.count += 1;
    return true;
  }
  return false;
}

/** Test hook. */
export function resetClientKeyBuckets(): void {
  buckets.clear();
}
