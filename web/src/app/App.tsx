import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type AdminState } from "../api/client.js";
import { useApp } from "./../auth/useAuth.js";
import { OverviewPage } from "../features/overview/OverviewPage.js";
import { ClientKeysPage } from "../features/client-keys/ClientKeysPage.js";
import { ProviderCredentialsPage } from "../features/provider-credentials/ProviderCredentialsPage.js";
import { ModelsPage } from "../features/models/ModelsPage.js";
import { LogsPage } from "../features/logs/LogsPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";

const TABS = ["Overview", "Client keys", "Providers", "Models", "Logs", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { authed, login, logout, toast } = useApp();
  const [tab, setTab] = useState<Tab>("Overview");
  const [state, setState] = useState<AdminState | null>(null);

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
        <div className="brand">Gemini Proxy</div>
        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <button className="btn btn-ghost" onClick={() => void logout()}>Log out</button>
      </header>

      <main>
        {state === null ? (
          <p className="hint center">Loading…</p>
        ) : (
          <>
            <OverviewPage state={state} reload={reload} />
            {tab === "Client keys" && <ClientKeysPage state={state} reload={reload} />}
            {tab === "Providers" && <ProviderCredentialsPage state={state} reload={reload} />}
            {tab === "Models" && <ModelsPage state={state} reload={reload} />}
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
        <h1>Gemini Proxy</h1>
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
