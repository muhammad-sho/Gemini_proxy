import type { ErrorClassification } from "../providers/adapter.js";
import { msUntilPacificMidnight } from "../../shared/time.js";

export interface CooldownPolicy {
  kind: "invalid_key" | "daily_quota" | "transient" | "none";
  durationMs: number;
  reason: string;
}

const TRANSIENT_COOLDOWN_MS = 60_000;
const INVALID_KEY_COOLDOWN_MS = 60_000;

export function cooldownFor(classification: ErrorClassification, detail?: {
  message?: string;
  quotaDetails?: unknown[];
}): CooldownPolicy {
  switch (classification) {
    case "invalid_key":
      return { kind: "invalid_key", durationMs: INVALID_KEY_COOLDOWN_MS, reason: "invalid_key" };
    case "daily_quota":
      return { kind: "daily_quota", durationMs: msUntilPacificMidnight(), reason: "daily_quota" };
    case "rate_limit":
      if (isDailyQuota(detail?.message, detail?.quotaDetails)) {
        return { kind: "daily_quota", durationMs: msUntilPacificMidnight(), reason: "daily_quota" };
      }
      return { kind: "transient", durationMs: TRANSIENT_COOLDOWN_MS, reason: "rate_limit" };
    case "transient":
      return { kind: "transient", durationMs: TRANSIENT_COOLDOWN_MS, reason: "upstream_error" };
    default:
      return { kind: "none", durationMs: 0, reason: classification };
  }
}

const DAILY_MESSAGE_RE = /\b(per[_ ]?day|daily|requests per day|\brpd)\b/i;

function isDailyQuota(message?: string, quotaDetails?: unknown[]): boolean {
  if (message && DAILY_MESSAGE_RE.test(message)) return true;
  if (Array.isArray(quotaDetails)) {
    const serialized = JSON.stringify(quotaDetails).toLowerCase();
    if (serialized.includes("perday") || serialized.includes("per_day")) return true;
  }
  return false;
}
