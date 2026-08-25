export type Theme = "light" | "dark";

const STORAGE_KEY = "gemini-proxy-theme";

/** Apply the theme to <html> and remember the choice. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? "light";
}

/**
 * Resolve the initial theme: explicit choice wins, otherwise follow the OS.
 * Called before React renders to avoid a flash of the wrong theme.
 */
export function initTheme(): Theme {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const theme: Theme = stored === "dark" || stored === "light"
    ? (stored as Theme)
    : (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  return theme;
}
