export interface AdminState {
  clientKeys: Array<{ id: string; label: string; allowedModels: string[]; createdAt: number }>;
  credentials: Array<{ id: string; label: string; provider: string; baseUrl: string | null; allowedModels: string[]; createdAt: number }>;
  models: Array<{ id: string; name: string; displayName?: string }>;
  groups: unknown[];
  usageByModel: Record<string, number>;
  cooling: Array<{ model_id: string; credential_id: string; cooldown_until: number; cooldown_reason: string | null }>;
}

export interface LogRow {
  id: number;
  traceId: string;
  modelId: string | null;
  method: string;
  path: string;
  responseStatus: number | null;
  latencyMs: number | null;
  attemptNumber: number;
  totalAttempts: number;
  finalOutcome: "success" | "error" | "timeout" | "aborted" | "no_keys";
  createdAt: number;
}

export interface LogDetail {
  id: number;
  trace_id: string;
  model_id: string | null;
  method: string;
  path: string;
  request_body: string | null;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  attempt_number: number;
  total_attempts: number;
  final_outcome: string;
  error_classification: string | null;
  timeline: TimelineEvent[];
  created_at: number;
}

export interface TimelineEvent {
  at: string;
  event: string;
  detail?: unknown;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find(c => c.startsWith(name + "="))
    ?.slice(name.length + 1);
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const isMutation = method !== "GET";
  if (isMutation) {
    const csrf = readCookie("gemini_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && onUnauthorized) {
    onUnauthorized();
    throw new ApiError(401, "Session expired");
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data?.error?.message ?? message;
    } catch { /* non-JSON */ }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (token: string) => request<{ ok: true }>("POST", "/api/admin/login", { token }),
  logout: () => request<{ ok: true }>("POST", "/api/admin/logout"),
  getState: () => request<AdminState>("GET", "/api/admin/v1/state"),

  createClientKey: (label: string, allowedModels: string[]) =>
    request<{ id: string; clientApiKey: string }>("POST", "/api/admin/v1/client-keys", { label, allowedModels }),
  deleteClientKey: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/v1/client-keys/${id}`),

  createCredential: (input: { label: string; provider: string; apiKey: string; baseUrl?: string; allowedModels: string[] }) =>
    request<{ id: string }>("POST", "/api/admin/v1/provider-credentials", input),
  updateCredential: (id: string, input: { label?: string; baseUrl?: string; allowedModels?: string[] }) =>
    request<{ ok: true }>("PUT", `/api/admin/v1/provider-credentials/${id}`, input),
  deleteCredential: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/v1/provider-credentials/${id}`),

  refreshModels: () => request<{ refreshed: number; errors: string[] }>("POST", "/api/admin/v1/models/refresh"),
  clearCooldowns: () => request<{ cleared: number }>("POST", "/api/admin/v1/cooldowns/clear"),

  listLogs: (params: { outcome?: string; q?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") search.set(k, String(v));
    }
    return request<{ total: number; logs: LogRow[] }>("GET", `/api/admin/v1/logs?${search}`);
  },
  getLog: (id: number) => request<LogDetail>("GET", `/api/admin/v1/logs/${id}`)
};
