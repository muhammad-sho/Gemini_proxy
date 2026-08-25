/** Compact relative timestamp for dashboard tables ("just now", "5m ago", …). */
export function relTime(epochSec: number, nowMs: number = Date.now()): string {
  const diff = nowMs / 1000 - epochSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
