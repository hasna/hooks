import type { HookEventRow } from "../db/schema.js";
import type { StorageRowsPayload, SyncResult } from "../storage.js";

type Env = Record<string, string | undefined>;
type HttpMethod = "GET" | "POST" | "DELETE";

const API_MODES = new Set(["api", "self_hosted", "cloud"]);
const POSTGRES_COMPAT_MODES = new Set(["remote", "hybrid"]);
const VALID_STORAGE_MODES = new Set(["local", "remote", "hybrid", ...API_MODES]);
const API_URL_ENV = ["HASNA_HOOKS_API_URL", "HOOKS_API_URL"] as const;
const API_KEY_ENV = ["HASNA_HOOKS_API_KEY", "HOOKS_API_KEY"] as const;
const DATABASE_URL_ENV = ["HASNA_HOOKS_DATABASE_URL", "HOOKS_DATABASE_URL"] as const;
const API_TIMEOUT_ENV = ["HASNA_HOOKS_API_TIMEOUT_MS", "HOOKS_API_TIMEOUT_MS"] as const;
const API_WRITE_TIMEOUT_ENV = ["HASNA_HOOKS_API_WRITE_TIMEOUT_MS", "HOOKS_API_WRITE_TIMEOUT_MS"] as const;

/** Deadline for interactive `hooks log` / `hooks storage` commands. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;
/**
 * Deadline for the hook event write path. Every agent tool call blocks on this
 * request, so an authority that accepts the connection and never answers must
 * fall through to the local spool in seconds rather than stalling the agent
 * until its own hook timeout kills the process and the event is lost.
 */
export const DEFAULT_API_WRITE_TIMEOUT_MS = 3_000;

export interface HooksApiTimeouts {
  request: number;
  write: number;
}

export interface HooksCliStorageModeResolution {
  mode: string;
  selected: boolean;
  source: "HASNA_HOOKS_STORAGE_MODE" | "HOOKS_STORAGE_MODE" | "default";
  warnings: string[];
}

export interface HooksApiAuthorityConfigStatus {
  selected: boolean;
  ok: boolean;
  mode: string;
  api_url_configured: boolean;
  api_key_configured: boolean;
  v1_base_url: string | null;
  issues: string[];
  warnings: string[];
  local_fallback: false;
}

export interface HooksApiClient {
  baseUrl: string;
  appendHookEvent(event: HookEventRow): Promise<HookEventRow>;
  listHookEvents(options?: { hook?: string; session?: string; limit?: number }): Promise<HookEventRow[]>;
  searchHookEvents(options: { text: string; limit?: number }): Promise<HookEventRow[]>;
  tailHookEvents(options?: { limit?: number }): Promise<HookEventRow[]>;
  listHookErrors(options?: { since?: string; limit?: number }): Promise<HookEventRow[]>;
  clearHookEvents(options?: { hook?: string }): Promise<number>;
  storageStatus(): Promise<unknown>;
  storagePush(options?: { tables?: string[] }): Promise<SyncResult[]>;
  storagePull(options?: { tables?: string[] }): Promise<SyncResult[]>;
  storageSync(options?: { tables?: string[] }): Promise<{ pull: SyncResult[]; push: SyncResult[] }>;
}

function clean(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function firstConfigured(env: Env, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function firstConfiguredName(env: Env, names: readonly string[]): string | null {
  for (const name of names) {
    if (env[name]?.trim()) return name;
  }
  return null;
}

/**
 * The API endpoint — never the credential alone — decides whether a legacy
 * `remote`/`hybrid` mode is routed over HTTP. A stray `HOOKS_API_KEY` in the
 * environment must not hijack the PostgreSQL storage path.
 */
function apiAuthorityConfigured(env: Env): boolean {
  return Boolean(firstConfigured(env, API_URL_ENV));
}

export function resolveHooksCliStorageMode(env: Env = process.env as Env): HooksCliStorageModeResolution {
  for (const source of ["HASNA_HOOKS_STORAGE_MODE", "HOOKS_STORAGE_MODE"] as const) {
    if (env[source] !== undefined && env[source]!.trim() === "") {
      throw new Error(
        `REMOTE_STORAGE_MODE_INVALID: ${source} must not be blank; local SQLite fallback is disabled for invalid routing state`,
      );
    }
  }

  const canonical = clean(env.HASNA_HOOKS_STORAGE_MODE);
  const fallback = clean(env.HOOKS_STORAGE_MODE);
  for (const [source, value] of [
    ["HASNA_HOOKS_STORAGE_MODE", canonical],
    ["HOOKS_STORAGE_MODE", fallback],
  ] as const) {
    if (value && !VALID_STORAGE_MODES.has(value)) {
      throw new Error(
        `REMOTE_STORAGE_MODE_INVALID: ${source}=${value} must be local, remote, hybrid, api, self_hosted, or cloud; ` +
          "local SQLite fallback is disabled",
      );
    }
  }

  const mode = canonical ?? fallback ?? "local";
  const postgresCompat = POSTGRES_COMPAT_MODES.has(mode);
  const selected = API_MODES.has(mode) || (postgresCompat && apiAuthorityConfigured(env));

  const warnings: string[] = [];
  if (selected && postgresCompat) {
    const databaseUrlEnv = firstConfiguredName(env, DATABASE_URL_ENV);
    if (databaseUrlEnv) {
      warnings.push(
        `REMOTE_TRANSPORT_AMBIGUOUS: ${mode} mode has both ${databaseUrlEnv} and ` +
          `${firstConfiguredName(env, API_URL_ENV)} configured; the HTTP /v1 authority takes precedence ` +
          "and PostgreSQL sync is not used",
      );
    }
  }

  return {
    mode,
    selected,
    source: canonical ? "HASNA_HOOKS_STORAGE_MODE" : fallback ? "HOOKS_STORAGE_MODE" : "default",
    warnings,
  };
}

export function getHooksApiAuthorityConfigStatus(env: Env = process.env as Env): HooksApiAuthorityConfigStatus {
  let resolution: HooksCliStorageModeResolution;
  try {
    resolution = resolveHooksCliStorageMode(env);
  } catch (error) {
    return {
      selected: true,
      ok: false,
      mode: clean(env.HASNA_HOOKS_STORAGE_MODE) ?? clean(env.HOOKS_STORAGE_MODE) ?? "invalid",
      api_url_configured: Boolean(firstConfigured(env, API_URL_ENV)),
      api_key_configured: Boolean(firstConfigured(env, API_KEY_ENV)),
      v1_base_url: null,
      issues: [error instanceof Error ? error.message : String(error)],
      warnings: [],
      local_fallback: false,
    };
  }

  if (!resolution.selected) {
    return {
      selected: false,
      ok: true,
      mode: resolution.mode,
      api_url_configured: false,
      api_key_configured: false,
      v1_base_url: null,
      issues: [],
      warnings: resolution.warnings,
      local_fallback: false,
    };
  }

  const issues: string[] = [];
  const rawApiUrl = firstConfigured(env, API_URL_ENV);
  let apiUrl: string | null = null;
  try {
    apiUrl = normalizeHooksApiUrl(rawApiUrl ?? undefined);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const apiKeyConfigured = Boolean(firstConfigured(env, API_KEY_ENV));
  if (!apiUrl && issues.length === 0) {
    issues.push("REMOTE_API_URL_MISSING: api Hooks storage requires HASNA_HOOKS_API_URL; local SQLite fallback is disabled");
  }
  if (!apiKeyConfigured) {
    issues.push("REMOTE_API_KEY_MISSING: api Hooks storage requires HASNA_HOOKS_API_KEY; local SQLite fallback is disabled");
  }

  return {
    selected: true,
    ok: issues.length === 0,
    mode: resolution.mode,
    api_url_configured: Boolean(rawApiUrl),
    api_key_configured: apiKeyConfigured,
    v1_base_url: apiUrl ? `${apiUrl}/v1` : null,
    issues,
    warnings: resolution.warnings,
    local_fallback: false,
  };
}

export function getHooksApiClient(env: Env = process.env as Env): HooksApiClient | null {
  const status = getHooksApiAuthorityConfigStatus(env);
  if (!status.selected) return null;
  if (!status.ok) throw new Error(status.issues[0]);
  const apiKey = firstConfigured(env, API_KEY_ENV)!;
  return new HttpHooksApiClient(status.v1_base_url!, apiKey, resolveHooksApiTimeouts(env));
}

/**
 * Request deadlines for the API client. A malformed override falls back to the
 * default rather than throwing: a typo in a performance knob must not be able
 * to disable the deadline that keeps hook writes from blocking forever.
 */
export function resolveHooksApiTimeouts(env: Env = process.env as Env): HooksApiTimeouts {
  return {
    request: resolveTimeoutMs(env, API_TIMEOUT_ENV, DEFAULT_API_TIMEOUT_MS),
    write: resolveTimeoutMs(env, API_WRITE_TIMEOUT_ENV, DEFAULT_API_WRITE_TIMEOUT_MS),
  };
}

function resolveTimeoutMs(env: Env, names: readonly string[], fallback: number): number {
  const raw = firstConfigured(env, names);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function normalizeHooksApiUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_HOOKS_API_URL must be an absolute http(s) URL; local SQLite fallback is disabled");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_HOOKS_API_URL must be an absolute http(s) URL; local SQLite fallback is disabled");
  }
  if (url.username || url.password) {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_HOOKS_API_URL must not contain userinfo; local SQLite fallback is disabled");
  }
  if (url.search || url.hash) {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_HOOKS_API_URL must not contain a query or fragment; local SQLite fallback is disabled");
  }
  if (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/") {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_HOOKS_API_URL must be an authority root or end in /v1; local SQLite fallback is disabled");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("REMOTE_API_URL_INVALID: plaintext HTTP is allowed only for loopback Hooks authorities; local SQLite fallback is disabled");
  }
  return url.origin;
}

class HttpHooksApiClient implements HooksApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeouts: HooksApiTimeouts,
  ) {}

  async appendHookEvent(event: HookEventRow): Promise<HookEventRow> {
    const data = await this.request<{ event: HookEventRow }>("POST", "/log/events", event, this.timeouts.write);
    return data.event;
  }

  async listHookEvents(options: { hook?: string; session?: string; limit?: number } = {}): Promise<HookEventRow[]> {
    const data = await this.request<{ events: HookEventRow[] }>("GET", `/log/events${queryString(options)}`);
    return data.events;
  }

  async searchHookEvents(options: { text: string; limit?: number }): Promise<HookEventRow[]> {
    const data = await this.request<{ events: HookEventRow[] }>("GET", `/log/search${queryString({ q: options.text, limit: options.limit })}`);
    return data.events;
  }

  async tailHookEvents(options: { limit?: number } = {}): Promise<HookEventRow[]> {
    const data = await this.request<{ events: HookEventRow[] }>("GET", `/log/events${queryString({ limit: options.limit })}`);
    return data.events;
  }

  async listHookErrors(options: { since?: string; limit?: number } = {}): Promise<HookEventRow[]> {
    const data = await this.request<{ events: HookEventRow[] }>("GET", `/log/errors${queryString(options)}`);
    return data.events;
  }

  async clearHookEvents(options: { hook?: string } = {}): Promise<number> {
    const data = await this.request<{ cleared: number }>("DELETE", `/log/events${queryString(options)}`);
    return data.cleared;
  }

  async storageStatus(): Promise<unknown> {
    return this.request("GET", "/storage/status");
  }

  async storagePush(options: { tables?: string[] } = {}): Promise<SyncResult[]> {
    // Imported lazily: hook processes route event writes through this client and
    // must not pay for the PostgreSQL adapter that ../storage.js pulls in.
    const { storageExportRows } = await import("../storage.js");
    const payload = storageExportRows({ tables: options.tables });
    const data = await this.request<{ results: SyncResult[] }>("POST", "/storage/import", payload);
    return data.results;
  }

  async storagePull(options: { tables?: string[] } = {}): Promise<SyncResult[]> {
    const { storageImportRows } = await import("../storage.js");
    const payload = await this.storageExport(options);
    return storageImportRows(payload, { direction: "pull" });
  }

  async storageSync(options: { tables?: string[] } = {}): Promise<{ pull: SyncResult[]; push: SyncResult[] }> {
    const pull = await this.storagePull(options);
    const push = await this.storagePush(options);
    return { pull, push };
  }

  private async storageExport(options: { tables?: string[] } = {}): Promise<StorageRowsPayload> {
    return this.request<StorageRowsPayload>("GET", `/storage/export${queryString({ tables: options.tables?.join(",") })}`);
  }

  private async request<T = unknown>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    timeoutMs: number = this.timeouts.request,
  ): Promise<T> {
    // The deadline covers the response body too, so an authority that answers
    // its headers and then stalls the stream is classified the same way.
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: "manual",
        signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw this.unreachable(path, timeoutMs, signal.aborted, error);
    }

    if (!response.ok) {
      await classifyRemoteResponse(this.baseUrl, path, response);
    }
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch (error) {
      if (signal.aborted) throw this.unreachable(path, timeoutMs, true, error);
      throw error;
    }
  }

  private unreachable(path: string, timeoutMs: number, timedOut: boolean, cause: unknown): Error {
    const reason = timedOut ? `did not respond within ${timeoutMs}ms` : "could not be reached";
    return new Error(
      `REMOTE_API_UNREACHABLE: configured Hooks authority ${authorityBase(this.baseUrl)} ${reason} for ${path}; ` +
        "local SQLite fallback is disabled",
      { cause },
    );
  }
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

async function classifyRemoteResponse(baseUrl: string, path: string, response: Response): Promise<never> {
  let message = "";
  try {
    const body = await response.json() as { error?: unknown };
    message = typeof body.error === "string" ? body.error : "";
  } catch {}

  if (response.status === 401) {
    throw new Error(`REMOTE_API_UNAUTHORIZED: configured Hooks authority ${authorityBase(baseUrl)} rejected HASNA_HOOKS_API_KEY for ${path}; local SQLite fallback is disabled`);
  }
  if (response.status === 403) {
    throw new Error(`REMOTE_API_FORBIDDEN: configured Hooks authority ${authorityBase(baseUrl)} denied ${path}; local SQLite fallback is disabled`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`REMOTE_API_REDIRECT_REJECTED: configured Hooks authority ${authorityBase(baseUrl)} redirected ${path}; authenticated redirects are disabled`);
  }
  if (response.status === 404) {
    throw new Error(`REMOTE_API_INCOMPATIBLE: configured Hooks authority ${authorityBase(baseUrl)} does not expose /v1${path}; local SQLite fallback is disabled`);
  }
  if (response.status >= 500) {
    throw new Error(`REMOTE_API_UNAVAILABLE: configured Hooks authority ${authorityBase(baseUrl)} returned HTTP ${response.status} for ${path}${message ? `: ${message}` : ""}; local SQLite fallback is disabled`);
  }
  throw new Error(`REMOTE_API_ERROR: configured Hooks authority ${authorityBase(baseUrl)} returned HTTP ${response.status} for ${path}${message ? `: ${message}` : ""}; local SQLite fallback is disabled`);
}

function authorityBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
