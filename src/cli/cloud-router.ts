import type { HookEventRow } from "../db/schema.js";
import {
  storageExportRows,
  storageImportRows,
  type StorageRowsPayload,
  type SyncResult,
} from "../storage.js";

type Env = Record<string, string | undefined>;
type HttpMethod = "GET" | "POST" | "DELETE";

const API_MODES = new Set(["api", "self_hosted", "cloud"]);
const POSTGRES_COMPAT_MODES = new Set(["remote", "hybrid"]);
const VALID_STORAGE_MODES = new Set(["local", "remote", "hybrid", ...API_MODES]);

export interface HooksCliStorageModeResolution {
  mode: string;
  selected: boolean;
  source: "HASNA_HOOKS_STORAGE_MODE" | "HOOKS_STORAGE_MODE" | "default";
}

export interface HooksApiAuthorityConfigStatus {
  selected: boolean;
  ok: boolean;
  mode: string;
  api_url_configured: boolean;
  api_key_configured: boolean;
  v1_base_url: string | null;
  issues: string[];
  local_fallback: false;
}

export interface HooksApiClient {
  baseUrl: string;
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

function apiConfigPresent(env: Env): boolean {
  return Boolean(firstConfigured(env, ["HASNA_HOOKS_API_URL", "HOOKS_API_URL"])) ||
    Boolean(firstConfigured(env, ["HASNA_HOOKS_API_KEY", "HOOKS_API_KEY"]));
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
  return {
    mode,
    selected: API_MODES.has(mode) || (POSTGRES_COMPAT_MODES.has(mode) && apiConfigPresent(env)),
    source: canonical ? "HASNA_HOOKS_STORAGE_MODE" : fallback ? "HOOKS_STORAGE_MODE" : "default",
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
      api_url_configured: Boolean(firstConfigured(env, ["HASNA_HOOKS_API_URL", "HOOKS_API_URL"])),
      api_key_configured: Boolean(firstConfigured(env, ["HASNA_HOOKS_API_KEY", "HOOKS_API_KEY"])),
      v1_base_url: null,
      issues: [error instanceof Error ? error.message : String(error)],
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
      local_fallback: false,
    };
  }

  const issues: string[] = [];
  const rawApiUrl = firstConfigured(env, ["HASNA_HOOKS_API_URL", "HOOKS_API_URL"]);
  let apiUrl: string | null = null;
  try {
    apiUrl = normalizeHooksApiUrl(rawApiUrl ?? undefined);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const apiKeyConfigured = Boolean(firstConfigured(env, ["HASNA_HOOKS_API_KEY", "HOOKS_API_KEY"]));
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
    local_fallback: false,
  };
}

export function getHooksApiClient(env: Env = process.env as Env): HooksApiClient | null {
  const status = getHooksApiAuthorityConfigStatus(env);
  if (!status.selected) return null;
  if (!status.ok) throw new Error(status.issues[0]);
  const apiKey = firstConfigured(env, ["HASNA_HOOKS_API_KEY", "HOOKS_API_KEY"])!;
  return new HttpHooksApiClient(status.v1_base_url!, apiKey);
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
  ) {}

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
    const payload = storageExportRows({ tables: options.tables });
    const data = await this.request<{ results: SyncResult[] }>("POST", "/storage/import", payload);
    return data.results;
  }

  async storagePull(options: { tables?: string[] } = {}): Promise<SyncResult[]> {
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

  private async request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `REMOTE_API_UNREACHABLE: configured Hooks authority ${authorityBase(this.baseUrl)} could not be reached for ${path}; ` +
          "local SQLite fallback is disabled",
        { cause: error },
      );
    }

    if (!response.ok) {
      await classifyRemoteResponse(this.baseUrl, path, response);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
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
