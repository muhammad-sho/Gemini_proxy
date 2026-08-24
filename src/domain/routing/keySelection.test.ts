import { describe, it, expect } from "vitest";
import { orderCandidates, type KeyCandidate } from "./keySelection.js";

const NOW = 1_000_000;

function mk(partial: Partial<KeyCandidate> & { credentialId: string }): KeyCandidate {
  return {
    modelId: "m",
    state: "ready",
    cooldownUntil: null,
    useCount: 0,
    ...partial
  };
}

describe("orderCandidates", () => {
  it("ready keys come before cooling keys", () => {
    const ordered = orderCandidates(
      [
        mk({ credentialId: "cooling", state: "cooling", cooldownUntil: NOW + 60_000 }),
        mk({ credentialId: "ready" })
      ],
      NOW
    );
    expect(ordered[0].candidate.credentialId).toBe("ready");
    expect(ordered[0].rank).toBe(0);
    expect(ordered[1].rank).toBe(1);
  });

  it("cooling keys sort by soonest expiry first", () => {
    const ordered = orderCandidates(
      [
        mk({ credentialId: "late", state: "cooling", cooldownUntil: NOW + 100_000 }),
        mk({ credentialId: "soon", state: "cooling", cooldownUntil: NOW + 10_000 })
      ],
      NOW
    );
    expect(ordered[0].candidate.credentialId).toBe("soon");
    expect(ordered[1].candidate.credentialId).toBe("late");
  });

  it("ready keys sort by least use first", () => {
    const ordered = orderCandidates(
      [
        mk({ credentialId: "busy", useCount: 5 }),
        mk({ credentialId: "fresh", useCount: 1 })
      ],
      NOW
    );
    expect(ordered[0].candidate.credentialId).toBe("fresh");
    expect(ordered[1].candidate.credentialId).toBe("busy");
  });

  it("expired cooldown is demoted to last resort (rank 2)", () => {
    const ordered = orderCandidates(
      [mk({ credentialId: "stale", state: "cooling", cooldownUntil: NOW - 1 })],
      NOW
    );
    expect(ordered[0].rank).toBe(2);
  });

  it("ordering is deterministic on equal rank and use count", () => {
    const a = [mk({ credentialId: "b" }), mk({ credentialId: "a" })];
    const o1 = orderCandidates(a, NOW);
    const o2 = orderCandidates([...a].reverse(), NOW);
    expect(o1.map(o => o.candidate.credentialId)).toEqual(["a", "b"]);
    expect(o2.map(o => o.candidate.credentialId)).toEqual(["a", "b"]);
  });
});
