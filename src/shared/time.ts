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