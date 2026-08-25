export type SelectionStrategy = "round_robin" | "least_used" | "fastest" | "smartest";

export interface KeyCandidate {
  credentialId: string;
  modelId: string;
  state: "ready" | "cooling" | "disabled";
  cooldownUntil: number | null;
  useCount: number;
  lastUsedAt: number | null;
  errorCount: number;
  avgLatencyMs: number | null;
  /** Creation order of the credential — oldest wins ties (deterministic). */
  createdAt?: number;
}

export interface OrderedCandidate {
  candidate: KeyCandidate;
  rank: 0 | 1 | 2;
}

function errorRate(c: KeyCandidate): number {
  return c.errorCount / Math.max(c.useCount, 1);
}

/**
 * Ordering of equally-healthy (same rank) candidates per strategy:
 *   round_robin — least recently picked first (strict rotation)
 *   least_used  — fewest total picks first
 *   fastest     — lowest EMA latency first, unknown latency last
 *   smartest    — lowest error rate, then latency, then usage
 */
export function compareByStrategy(
  strategy: SelectionStrategy,
  a: KeyCandidate,
  b: KeyCandidate
): number {
  const byId = () => a.credentialId.localeCompare(b.credentialId);
  const byCreation = () => {
    if (a.createdAt !== undefined && b.createdAt !== undefined && a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return byId();
  };

  switch (strategy) {
    case "round_robin": {
      const au = a.lastUsedAt ?? 0;
      const bu = b.lastUsedAt ?? 0;
      return au !== bu ? au - bu : byCreation();
    }
    case "fastest": {
      const av = a.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      const bv = b.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      if (a.useCount !== b.useCount) return a.useCount - b.useCount;
      return byCreation();
    }
    case "smartest": {
      const ae = errorRate(a);
      const be = errorRate(b);
      if (ae !== be) return ae - be;
      const av = a.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      const bv = b.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      if (a.useCount !== b.useCount) return a.useCount - b.useCount;
      return byCreation();
    }
    case "least_used":
    default: {
      if (a.useCount !== b.useCount) return a.useCount - b.useCount;
      return byCreation();
    }
  }
}

/**
 * Deterministic best-to-worst ordering:
 *   rank 0: ready keys, ordered by `strategy`
 *   rank 1: cooling keys (usable fallback), soonest expiry first
 *   rank 2: everything else, last resort
 */
export function orderCandidates(
  candidates: KeyCandidate[],
  nowMs: number,
  strategy: SelectionStrategy = "least_used"
): OrderedCandidate[] {
  const ranked = candidates.map(candidate => {
    let rank: 0 | 1 | 2;
    if (candidate.state === "ready") {
      rank = 0;
    } else if (candidate.state === "cooling" && (candidate.cooldownUntil ?? 0) > nowMs) {
      // Active cooldown: usable fallback, soonest expiry first.
      rank = 1;
    } else {
      // Expired cooldown entries should have been promoted to ready upstream;
      // treat anything else as last resort.
      rank = 2;
    }
    return { candidate, rank };
  });

  return ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Within the same rank: cooling keys always by soonest recovery.
    if (
      a.rank === 1 &&
      b.rank === 1
    ) {
      const au = a.candidate.cooldownUntil ?? 0;
      const bu = b.candidate.cooldownUntil ?? 0;
      if (au !== bu) return au - bu;
      return compareByStrategy(strategy, a.candidate, b.candidate);
    }
    return compareByStrategy(strategy, a.candidate, b.candidate);
  });
}
