export interface GroupPair {
  credentialId: string;
  modelId: string;
}

export interface GroupCreateInput {
  name: string;
  description?: string;
  routingStrategy: Group["routingStrategy"];
  fallbackStrategy?: Group["fallbackStrategy"];
  pairs: GroupPair[];
}

export interface Group {
  id: string;
  name: string;
  description: string;
  routingStrategy: "round_robin" | "least_used" | "fastest" | "smartest";
  fallbackStrategy: "round_robin" | "least_used" | "fastest" | "smartest" | null;
  pairs: GroupPair[];
  createdAt: number;
  updatedAt: number;
}

export interface AdminState {
  clientKeys: Array<{
    id: string; label: string; allowedModels: string[]; allowedGroups: string[]; createdAt: number;
  }>;
  credentials: Array<{ id: string; label: string; provider: string; baseUrl: string | null; allowedModels: string[]; createdAt: number }>;
  models: Array<{ id: string }>;
  pairs: Array<{ credentialId: string; credentialLabel: string; modelId: string }>;
  groups: Group[];
  cooling: Array<{ model_id: string; credential_id: string; cooldown_until: number; cooldown_reason: string | null }>;
}

export interface AuditEntry {
  id: number;
  action: string;
  entityType: string | null;
  entityId: string | null;
  adminUserId: number | null;
  ipAddress: string | null;
  createdAt: number;
}

export interface UsageSummary {
  days: 1 | 7;
  models: Array<{ modelId: string; requests: number; promptTokens: number; completionTokens: number }>;
  generatedAt: number;
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

export interface ProxySettings {
  keyFallbackAttempts: number;
  keyLoopDeadlineMs: number;
  requestTimeoutMs: number;
  logBodyMaxBytes: number;
  maxLogEntries: number;
  rateLimitPerMinute: number;
  clientKeyRatePerMinute: number;
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
  getSetupStatus: () => request<{ setupRequired: boolean }>("GET", "/api/admin/v1/setup/status"),
  setup: (password: string) => request<{ ok: true }>("POST", "/api/admin/v1/setup", { password }),
  login: (token: string) => request<{ ok: true }>("POST", "/api/admin/v1/login", { token }),
  logout: () => request<{ ok: true }>("POST", "/api/admin/v1/logout"),
  getState: () => request<AdminState>("GET", "/api/admin/v1/state"),
  getUsageSummary: (days: 1 | 7) =>
    request<UsageSummary>("GET", `/api/admin/v1/usage-summary?days=${days}`),
  listAuditLogs: (params: { action?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") search.set(k, String(v));
    }
    return request<{ total: number; actions: string[]; logs: AuditEntry[] }>(
      "GET", `/api/admin/v1/audit-logs?${search}`
    );
  },

  getSettings: () => request<ProxySettings>("GET", "/api/admin/v1/settings"),
  updateSettings: (patch: Partial<ProxySettings>) => request<ProxySettings>("PUT", "/api/admin/v1/settings", patch),

  createClientKey: (label: string, allowedModels: string[], allowedGroups: string[]) =>
    request<{ id: string; clientApiKey: string }>("POST", "/api/admin/v1/client-keys", { label, allowedModels, allowedGroups }),
  updateClientKey: (id: string, patch: { label?: string; allowedModels?: string[]; allowedGroups?: string[] }) =>
    request<{ ok: true }>("PUT", `/api/admin/v1/client-keys/${id}`, patch),
  deleteClientKey: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/v1/client-keys/${id}`),

  createCredential: (input: { label: string; provider: string; apiKey: string; baseUrl?: string; allowedModels: string[] }) =>
    request<{ id: string }>("POST", "/api/admin/v1/provider-credentials", input),
  updateCredential: (id: string, input: { label?: string; baseUrl?: string; allowedModels?: string[] }) =>
    request<{ ok: true }>("PUT", `/api/admin/v1/provider-credentials/${id}`, input),
  deleteCredential: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/v1/provider-credentials/${id}`),

  probeProviderModels: (input: { provider: string; apiKey: string; baseUrl?: string }) =>
    request<{ models: Array<{ id: string; displayName: string }> }>("POST", "/api/admin/v1/provider-models/probe", input),
  getCredentialModels: (id: string) =>
    request<{ models: Array<{ id: string; displayName: string }> }>("GET", `/api/admin/v1/provider-credentials/${id}/models`),

  createGroup: (input: GroupCreateInput) => request<Group>("POST", "/api/admin/v1/groups", input),
  updateGroup: (id: string, patch: Partial<GroupCreateInput>) =>
    request<Group>("PUT", `/api/admin/v1/groups/${id}`, patch),
  deleteGroup: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/v1/groups/${id}`),
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
