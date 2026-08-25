export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const PACIFIC_TZ = "America/Los_Angeles";

/**
 * Wall-clock time of day in America/Los_Angeles, in milliseconds since that
 * zone's local midnight. Uses Intl parts instead of locale string parsing so
 * the result never depends on the host timezone.
 */
function pacificMillisIntoDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  return (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000 + now.getMilliseconds();
}

/** Milliseconds until the next midnight in America/Los_Angeles; always in (0, 24h]. */
export function msUntilPacificMidnight(): number {
  return 86_400_000 - pacificMillisIntoDay(new Date());
}
