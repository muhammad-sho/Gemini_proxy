export function nowMs(): number {
  return Date.now();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function pacificMidnightTimestamp(): number {
  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  pacific.setHours(24, 0, 0, 0);
  return pacific.getTime();
}

export function msUntilPacificMidnight(): number {
  return pacificMidnightTimestamp() - Date.now();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}