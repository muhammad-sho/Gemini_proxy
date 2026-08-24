import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type AdminState } from "../api/client.js";
import { useApp } from "./../auth/useAuth.js";
import { OverviewPage } from "../features/overview/OverviewPage.js";
import { ClientKeysPage } from "../features/client-keys/ClientKeysPage.js";
import { ProviderCredentialsPage } from "../features/provider-credentials/ProviderCredentialsPage.js";
import { ModelsPage } from "../features/models/ModelsPage.js";
import { LogsPage } from "../features/logs/LogsPage.js";

const TABS = ["Overview", "Client keys", "Providers", "Models", "Logs"] as const;
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
          </>
        )}
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onLogin(token);
    } catch (err) {
      toast("error", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="login-card form">
        <h1>Gemini Proxy</h1>
        <p className="hint">Enter the admin token (SETUP_TOKEN) to manage the proxy.</p>
        <label>
          Admin token
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        <button className="btn btn-primary" disabled={busy || !token}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
