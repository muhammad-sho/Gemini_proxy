import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AdminState } from "../api/client.js";
import { useApp } from "./../auth/useAuth.js";
import { applyTheme, currentTheme, type Theme } from "../theme.js";
import { OverviewPage } from "../features/overview/OverviewPage.js";
import { ClientKeysPage } from "../features/client-keys/ClientKeysPage.js";
import { ProviderCredentialsPage } from "../features/provider-credentials/ProviderCredentialsPage.js";
import { GroupsPage } from "../features/groups/GroupsPage.js";
import { LogsPage } from "../features/logs/LogsPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";

const TABS = ["Overview", "Client keys", "Providers", "Groups", "Logs", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { authed, login, logout } = useApp();
  const [tab, setTab] = useState<Tab>("Overview");
  const [state, setState] = useState<AdminState | null>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  // On narrow screens the tab strip scrolls horizontally; keep the active tab
  // visible when it changes (keyboard arrows or tap on a partly clipped tab).
  useEffect(() => {
    // Optional chaining also guards jsdom, which lacks scrollIntoView.
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  const reload = useCallback(async () => {
    try {
      setState(await api.getState());
    } catch {
      /* 401 handled globally */
    }
  }, []);

  useEffect(() => {
    if (authed) void reload();
    else setState(null);
  }, [authed, reload]);

  if (!authed) return <LoginScreen onLogin={login} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-badge" aria-hidden>AG</span>
          <span className="brand-text">
            <span className="brand-title">AI Gate Proxy</span>
            <span className="brand-sub">Key-pooling gateway for Gemini &amp; OpenAI-compatible APIs</span>
          </span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Dashboard sections">
          {TABS.map((t, i) => (
            <button
              key={t}
              ref={tab === t ? activeTabRef : undefined}
              role="tab"
              id={`tab-${t.replace(/\s+/g, "-").toLowerCase()}`}
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
              onKeyDown={e => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const delta = e.key === "ArrowRight" ? 1 : -1;
                const next = TABS[(i + delta + TABS.length) % TABS.length];
                setTab(next);
                document.getElementById(`tab-${next.replace(/\s+/g, "-").toLowerCase()}`)?.focus();
              }}
            >
              {t}
            </button>
          ))}
        </nav>
        <button
          className="btn btn-ghost"
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}
        </button>
        <button className="btn btn-ghost" onClick={() => void logout()}>Log out</button>
      </header>

      <main>
        {state === null ? (
          <p className="hint center">Loading…</p>
        ) : (
          <>
            {tab === "Overview" && <OverviewPage state={state} reload={reload} />}
            {tab === "Client keys" && <ClientKeysPage state={state} reload={reload} />}
            {tab === "Providers" && <ProviderCredentialsPage state={state} reload={reload} />}
            {tab === "Groups" && <GroupsPage state={state} reload={reload} />}
            {tab === "Logs" && <LogsPage />}
            {tab === "Settings" && <SettingsPage />}
          </>
        )}
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [mode, setMode] = useState<"checking" | "setup" | "login">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  useEffect(() => {
    let cancelled = false;
    api.getSetupStatus()
      .then(r => { if (!cancelled) setMode(r.setupRequired ? "setup" : "login"); })
      .catch(() => { if (!cancelled) setMode("login"); });
    return () => { cancelled = true; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "checking") return;
    if (mode === "setup" && password !== confirm) {
      toast("error", "Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (mode === "setup") {
        await api.setup(password);
        toast("info", "Admin account created");
      }
      await onLogin(password);
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const isSetup = mode === "setup";

  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="login-card form">
        <h1>AI Gate Proxy</h1>
        {isSetup ? (
          <>
            <p className="hint">First run: create the admin password for this proxy.</p>
            <label>
              Admin password
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
                autoComplete="new-password"
              />
              <small className="hint">At least 8 characters.</small>
            </label>
            <label>
              Confirm password
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>
            <button className="btn btn-primary" disabled={busy || password.length < 8}>
              {busy ? "Creating…" : "Create admin account"}
            </button>
          </>
        ) : (
          <>
            <p className="hint">Enter your admin password to manage the proxy.</p>
            <label>
              Admin password
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
              />
            </label>
            <button className="btn btn-primary" disabled={busy || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
