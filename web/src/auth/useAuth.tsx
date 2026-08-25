import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api/client.js";

interface Toast { id: number; kind: "error" | "info"; message: string }

interface AppContextValue {
  authed: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  toast: (kind: "error" | "info", message: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const authedRef = useRef(false);

  const toast = useCallback((kind: "error" | "info", message: string) => {
    const id = nextId.current++;
    setToasts(t => [...t, { id, kind, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const markAuthed = useCallback((value: boolean) => {
    authedRef.current = value;
    setAuthed(value);
  }, []);

  const login = useCallback(async (token: string) => {
    await api.login(token);
    markAuthed(true);
  }, [markAuthed]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* best-effort */ }
    markAuthed(false);
  }, [markAuthed]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only surface "expired" when the user was signed in — a wrong password
      // on the login form is also a 401 and must not spam this toast.
      if (authedRef.current) {
        toast("error", "Session expired — please sign in again");
      }
      markAuthed(false);
    });
    // Probe session validity on mount
    api.getState().then(() => markAuthed(true)).catch(() => markAuthed(false));
    return () => { setUnauthorizedHandler(null); };
  }, [toast, markAuthed]);

  return (
    <AppContext.Provider value={{ authed, login, logout, toast }}>
      {children}
      <div className="toast-stack" role="status">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
