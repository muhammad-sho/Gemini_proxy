export interface KeyCandidate {
  credentialId: string;
  modelId: string;
  state: "ready" | "cooling" | "disabled";
  cooldownUntil: number | null;
  useCount: number;
  /** Creation order of the credential — oldest wins ties (deterministic). */
  createdAt?: number;
}

export interface OrderedCandidate {
  candidate: KeyCandidate;
  rank: 0 | 1 | 2;
}

/**
 * Deterministic best-to-worst ordering:
 *   rank 0: ready keys, least-used first
 *   rank 1: cooling keys, soonest expiry first
 *   rank 2: disabled keys, last resort
 */
export function orderCandidates(candidates: KeyCandidate[], nowMs: number): OrderedCandidate[] {
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
    // Within the same rank: cooling keys by soonest recovery...
    const au = a.candidate.cooldownUntil;
    const bu = b.candidate.cooldownUntil;
    if (
      a.candidate.state === "cooling" &&
      b.candidate.state === "cooling" &&
      au !== null && bu !== null &&
      au !== bu
    ) {
      return au - bu;
    }
    // ...otherwise least-used first...
    if (a.candidate.useCount !== b.candidate.useCount) {
      return a.candidate.useCount - b.candidate.useCount;
    }
    // ...then oldest credential first (stable insertion order)...
    const ac = a.candidate.createdAt;
    const bc = b.candidate.createdAt;
    if (ac !== undefined && bc !== undefined && ac !== bc) {
      return ac - bc;
    }
    // ...with a deterministic id tie-break.
    return a.candidate.credentialId.localeCompare(b.candidate.credentialId);
  });
}
