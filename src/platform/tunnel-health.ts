import { readFile as nodeReadFile } from "node:fs/promises";
import { redactText } from "../logging/redactor";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_BODY_CHARS = 256;
const MAX_DIAGNOSTIC_BODY_BYTES = 64 * 1024;
const MAX_METRIC_LINES = 256;
export const POLLING_STALE_AFTER_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type TunnelHealthState = "ready" | "not_ready" | "unreachable" | "not_configured" | "invalid";

export interface TunnelHealthEndpoint {
  ok: boolean;
  status: number | null;
  body?: string;
  error?: string;
}

export interface TunnelHealthStatus {
  baseUrl: string | null;
  state: TunnelHealthState;
  healthz: TunnelHealthEndpoint;
  readyz: TunnelHealthEndpoint;
}

export interface TunnelDiagnosticEndpoint {
  available: boolean;
  status: number | null;
  error?: string;
  selected?: TunnelSelectedDiagnostics;
}

export interface TunnelComponentDiagnostics {
  status?: string;
  pid?: number;
}

export interface TunnelPollingDiagnostics {
  lastSuccessAt?: string;
  ageMs?: number;
  stale?: boolean;
}

export interface TunnelSelectedDiagnostics {
  liveness: boolean;
  readiness: boolean;
  pid?: number;
  polling?: TunnelPollingDiagnostics;
  queue?: { depth?: number };
  workers?: { active?: number; capacity?: number; occupancy?: number };
  mcp?: TunnelComponentDiagnostics;
  channel?: TunnelComponentDiagnostics;
  controlPlane?: { reachable?: boolean; stale?: boolean };
}

export interface TunnelDiagnostics extends TunnelHealthStatus {
  api: {
    status: TunnelDiagnosticEndpoint;
    system: TunnelDiagnosticEndpoint;
  };
  metrics: TunnelDiagnosticEndpoint;
  selected: TunnelSelectedDiagnostics;
}

type ReadFile = (path: string, encoding: "utf8") => Promise<string>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TunnelHealthProbeDependencies {
  readFile?: ReadFile;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
}

export async function probeTunnelHealth(
  healthUrlFile: string,
  deps: TunnelHealthProbeDependencies = {},
): Promise<TunnelHealthStatus> {
  const readFile = deps.readFile ?? nodeReadFile;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let rawUrl: string;
  try {
    rawUrl = (await readFile(healthUrlFile, "utf8")).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return emptyStatus(code === "ENOENT" ? "not_configured" : "unreachable", safeError(error));
  }

  const baseUrl = validateLocalHealthUrl(rawUrl);
  if (!baseUrl) return emptyStatus("invalid", "health URL must be loopback HTTP without credentials");

  const [healthz, readyz] = await Promise.all([
    probeEndpoint(new URL("/healthz", `${baseUrl}/`).toString(), fetcher, timeoutMs),
    probeEndpoint(new URL("/readyz", `${baseUrl}/`).toString(), fetcher, timeoutMs),
  ]);

  const state: TunnelHealthState = healthz.ok && readyz.ok
    ? "ready"
    : healthz.ok
      ? "not_ready"
      : "unreachable";

  return { baseUrl, state, healthz, readyz };
}

function validateLocalHealthUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function probeEndpoint(url: string, fetcher: Fetch, timeoutMs: number): Promise<TunnelHealthEndpoint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetcher(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    const body = await readBoundedBody(response, MAX_BODY_CHARS);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, error: safeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function emptyStatus(state: TunnelHealthState, error: string): TunnelHealthStatus {
  const endpoint = (): TunnelHealthEndpoint => ({ ok: false, status: null, error });
  return { baseUrl: null, state, healthz: endpoint(), readyz: endpoint() };
}

function safeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, MAX_BODY_CHARS);
}

export async function probeTunnelDiagnostics(
  healthUrlFile: string,
  deps: TunnelHealthProbeDependencies = {},
): Promise<TunnelDiagnostics> {
  const readFile = deps.readFile ?? nodeReadFile;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  let rawUrl: string;
  try {
    rawUrl = (await readFile(healthUrlFile, "utf8")).trim();
  } catch (error) {
    const state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_configured" : "unreachable";
    return emptyDiagnostics(state, safeError(error));
  }

  const baseUrl = validateLocalHealthUrl(rawUrl);
  if (!baseUrl) return emptyDiagnostics("invalid", "health URL must be loopback HTTP without credentials");

  const urls = {
    healthz: new URL("/healthz", `${baseUrl}/`).toString(),
    readyz: new URL("/readyz", `${baseUrl}/`).toString(),
    status: new URL("/api/status", `${baseUrl}/`).toString(),
    system: new URL("/api/system", `${baseUrl}/`).toString(),
    metrics: new URL("/metrics", `${baseUrl}/`).toString(),
  };
  const [healthz, readyz, status, system, metrics] = await Promise.all([
    probeEndpoint(urls.healthz, fetcher, timeoutMs),
    probeEndpoint(urls.readyz, fetcher, timeoutMs),
    probeDiagnosticEndpoint(urls.status, fetcher, timeoutMs, "json"),
    probeDiagnosticEndpoint(urls.system, fetcher, timeoutMs, "json"),
    probeDiagnosticEndpoint(urls.metrics, fetcher, timeoutMs, "metrics"),
  ]);

  const state: TunnelHealthState = healthz.ok && readyz.ok
    ? "ready"
    : healthz.ok
      ? "not_ready"
      : "unreachable";
  const selected = mergeSelected(
    { liveness: healthz.ok, readiness: readyz.ok },
    status.selected,
    system.selected,
    metrics.selected,
  );
  if (selected.polling?.ageMs !== undefined) {
    selected.polling.stale = selected.polling.stale ?? selected.polling.ageMs > POLLING_STALE_AFTER_MS;
  }
  if (selected.polling?.stale !== undefined || selected.controlPlane?.reachable !== undefined) {
    selected.controlPlane = {
      ...selected.controlPlane,
      ...(selected.polling?.stale !== undefined ? { stale: selected.polling.stale } : {}),
    };
  }

  return {
    baseUrl,
    state,
    healthz,
    readyz,
    api: { status, system },
    metrics,
    selected: withPollingAge(selected, now),
  };
}

async function probeDiagnosticEndpoint(
  url: string,
  fetcher: Fetch,
  timeoutMs: number,
  format: "json" | "metrics",
): Promise<TunnelDiagnosticEndpoint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetcher(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    const body = await readBoundedBody(response, MAX_DIAGNOSTIC_BODY_BYTES);
    const selected = format === "json" ? parseSelectedJson(body) : parseSelectedMetrics(body);
    return {
      available: response.ok,
      status: response.status,
      ...(response.ok ? { selected } : {}),
      ...(!response.ok ? { error: `HTTP ${response.status}` } : {}),
    };
  } catch (error) {
    return { available: false, status: null, error: safeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function emptyDiagnostics(state: TunnelHealthState, error: string): TunnelDiagnostics {
  const endpoint = (): TunnelDiagnosticEndpoint => ({ available: false, status: null, error });
  return {
    ...emptyStatus(state, error),
    api: { status: endpoint(), system: endpoint() },
    metrics: endpoint(),
    selected: { liveness: false, readiness: false },
  };
}

function parseSelectedJson(body: string): TunnelSelectedDiagnostics {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) return { liveness: false, readiness: false };
    return selectFromObject(value);
  } catch {
    return { liveness: false, readiness: false };
  }
}

function selectFromObject(value: Record<string, unknown>): TunnelSelectedDiagnostics {
  const selected: TunnelSelectedDiagnostics = { liveness: false, readiness: false };
  const mcp = findRecord(value, ["mcp", "mcp_server", "mcpserver"]);
  const channel = findRecord(value, ["channel", "mcp_channel", "mcpchannel", "channels"]);
  const polling = findRecord(value, ["polling", "poll", "dispatcher"]);
  const queue = findRecord(value, ["queue", "dispatcher_queue", "pending"]);
  const workers = findRecord(value, ["workers", "worker", "dispatcher_workers"]);
  const controlPlane = findRecord(value, ["control_plane", "controlplane", "control"]);
  const process = findRecord(value, ["process", "runtime", "tunnel_process"]);

  const pid = firstNumber(value, ["pid", "process_pid", "tunnel_pid"]) ??
    (process ? firstNumber(process, ["pid", "process_pid"]) : undefined);
  if (pid !== undefined) selected.pid = pid;
  const mcpComponent = mcp
    ? component(mcp, ["mcp_status", "mcp_state"])
    : rootComponent(value, ["mcp_status", "mcp_state"], ["mcp_pid", "mcp_process_pid"]);
  if (mcpComponent) selected.mcp = mcpComponent;
  const channelComponent = channel
    ? component(channel, ["channel_status", "channel_state"])
    : rootComponent(value, ["channel_status", "channel_state"], ["channel_pid", "mcp_channel_pid"]);
  if (channelComponent) selected.channel = channelComponent;

  const pollingValue = polling ?? value;
  const lastSuccessAt = firstTimestamp(pollingValue, [
    "last_success_at", "last_success", "last_poll_at", "last_poll", "last_poll_timestamp",
  ]);
  const stale = firstBoolean(pollingValue, ["stale", "polling_stale"]);
  const ageMs = firstNumber(pollingValue, ["age_ms", "poll_age_ms", "polling_age_ms", "last_poll_age_ms"]);
  const ageSeconds = firstNumber(pollingValue, ["age_seconds", "poll_age_seconds", "polling_age_seconds", "last_poll_age_seconds"]);
  if (lastSuccessAt !== undefined || stale !== undefined || ageMs !== undefined || ageSeconds !== undefined) {
    selected.polling = {
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(ageMs !== undefined && ageMs >= 0 ? { ageMs } : ageSeconds !== undefined && ageSeconds >= 0 ? { ageMs: ageSeconds * 1_000 } : {}),
      ...(stale !== undefined ? { stale } : {}),
    };
    if (selected.polling.stale === undefined && selected.polling.ageMs !== undefined) {
      selected.polling.stale = selected.polling.ageMs > POLLING_STALE_AFTER_MS;
    }
  }

  const depth = firstNumber(queue ?? value, ["depth", "queue_depth", "pending", "queued"]);
  if (depth !== undefined) selected.queue = { depth };
  const active = firstNumber(workers ?? value, ["active", "active_workers", "busy", "in_flight", "inflight"]);
  const capacity = firstNumber(workers ?? value, ["capacity", "max", "max_workers", "concurrency"]);
  const occupancy = firstNumber(workers ?? value, ["occupancy", "utilization", "utilisation"]);
  if (active !== undefined || capacity !== undefined || occupancy !== undefined) {
    selected.workers = {
      ...(active !== undefined ? { active } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(occupancy !== undefined && occupancy >= 0
        ? { occupancy }
        : active !== undefined && capacity !== undefined && capacity > 0 ? { occupancy: active / capacity } : {}),
    };
  }

  const reachable = firstBoolean(controlPlane ?? value, ["reachable", "connected", "online"]);
  const controlStale = firstBoolean(controlPlane ?? value, ["stale", "polling_stale"]);
  if (reachable !== undefined || controlStale !== undefined) {
    selected.controlPlane = {
      ...(reachable !== undefined ? { reachable } : {}),
      ...(controlStale !== undefined ? { stale: controlStale } : {}),
    };
  }
  const liveness = firstBoolean(value, ["liveness", "live", "alive"]);
  const readiness = firstBoolean(value, ["readiness", "ready"]);
  if (liveness !== undefined) selected.liveness = liveness;
  if (readiness !== undefined) selected.readiness = readiness;
  return selected;
}

function parseSelectedMetrics(body: string): TunnelSelectedDiagnostics {
  const selected: TunnelSelectedDiagnostics = { liveness: false, readiness: false };
  let lastSuccessAt: string | undefined;
  let queueDepth: number | undefined;
  let active: number | undefined;
  let capacity: number | undefined;
  let pollingAgeMs: number | undefined;
  let workerOccupancy: number | undefined;
  for (const line of body.split(/\r?\n/).slice(0, MAX_METRIC_LINES)) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.replace(/\{.*$/, "").toLowerCase();
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    if (/(?:poll|dispatch)/.test(name) && /(?:last|success|timestamp)/.test(name)) {
      lastSuccessAt = timestampFromEpoch(number);
    } else if (/(?:poll|dispatch)/.test(name) && /(?:age|lag)/.test(name)) {
      pollingAgeMs = number * 1_000;
    } else if (/queue/.test(name) && /(?:depth|pending|queued|size)/.test(name)) {
      queueDepth = number;
    } else if (/worker/.test(name) && /(?:active|busy|running|inflight|in_flight)/.test(name)) {
      active = number;
    } else if (/worker/.test(name) && /(?:capacity|max|concurrency|limit)/.test(name)) {
      capacity = number;
    } else if (/worker/.test(name) && /occupancy/.test(name) && number >= 0) {
      workerOccupancy = number;
    } else if (/(?:liveness|healthz|alive)/.test(name)) {
      selected.liveness = number > 0;
    } else if (/(?:readiness|readyz)/.test(name)) {
      selected.readiness = number > 0;
    } else if (/mcp/.test(name) && /(?:connected|ready|status)/.test(name)) {
      selected.mcp = { status: number > 0 ? "connected" : "disconnected" };
    } else if (/channel/.test(name) && /(?:connected|ready|status)/.test(name)) {
      selected.channel = { status: number > 0 ? "connected" : "disconnected" };
    } else if (/(?:^|_)pid$/.test(name) || /process_pid/.test(name)) {
      selected.pid = number;
    }
  }
  if (lastSuccessAt || pollingAgeMs !== undefined) {
    selected.polling = {
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(pollingAgeMs !== undefined && pollingAgeMs >= 0 ? { ageMs: pollingAgeMs, stale: pollingAgeMs > POLLING_STALE_AFTER_MS } : {}),
    };
  }
  if (queueDepth !== undefined) selected.queue = { depth: queueDepth };
  if (active !== undefined || capacity !== undefined || workerOccupancy !== undefined) {
    selected.workers = {
      ...(active !== undefined ? { active } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(workerOccupancy !== undefined
        ? { occupancy: workerOccupancy }
        : active !== undefined && capacity !== undefined && capacity > 0 ? { occupancy: active / capacity } : {}),
    };
  }
  return selected;
}

function withPollingAge(selected: TunnelSelectedDiagnostics, now: () => number): TunnelSelectedDiagnostics {
  const lastSuccessAt = selected.polling?.lastSuccessAt;
  if (!lastSuccessAt) return selected;
  const timestamp = Date.parse(lastSuccessAt);
  if (!Number.isFinite(timestamp)) return selected;
  const ageMs = Math.max(0, now() - timestamp);
  return {
    ...selected,
    polling: {
      ...selected.polling,
      ageMs,
      stale: selected.polling?.stale ?? ageMs > POLLING_STALE_AFTER_MS,
    },
    controlPlane: {
      ...selected.controlPlane,
      stale: selected.controlPlane?.stale ?? ageMs > POLLING_STALE_AFTER_MS,
    },
  };
}

function mergeSelected(...values: Array<TunnelSelectedDiagnostics | undefined>): TunnelSelectedDiagnostics {
  const result: TunnelSelectedDiagnostics = { liveness: false, readiness: false };
  for (const value of values) {
    if (!value) continue;
    result.liveness = value.liveness || result.liveness;
    result.readiness = value.readiness || result.readiness;
    if (value.pid !== undefined) result.pid = value.pid;
    if (value.polling) result.polling = { ...result.polling, ...value.polling };
    if (value.queue) result.queue = { ...result.queue, ...value.queue };
    if (value.workers) result.workers = { ...result.workers, ...value.workers };
    if (value.mcp) result.mcp = { ...result.mcp, ...value.mcp };
    if (value.channel) result.channel = { ...result.channel, ...value.channel };
    if (value.controlPlane) result.controlPlane = { ...result.controlPlane, ...value.controlPlane };
  }
  if (result.workers?.active !== undefined && result.workers.capacity !== undefined && result.workers.capacity > 0) {
    result.workers.occupancy ??= result.workers.active / result.workers.capacity;
  }
  return result;
}

function component(value: Record<string, unknown>, fallbackKeys: string[]): TunnelComponentDiagnostics | undefined {
  const status = firstString(value, ["status", "state", "connection", ...fallbackKeys]);
  const pid = firstNumber(value, ["pid", "process_pid"]);
  return status !== undefined || pid !== undefined ? {
    ...(status !== undefined ? { status: status.slice(0, 64) } : {}),
    ...(pid !== undefined ? { pid } : {}),
  } : undefined;
}

function rootComponent(
  value: Record<string, unknown>,
  statusKeys: string[],
  pidKeys: string[],
): TunnelComponentDiagnostics | undefined {
  const status = firstString(value, statusKeys);
  const pid = firstNumber(value, pidKeys);
  return status !== undefined || pid !== undefined ? {
    ...(status !== undefined ? { status: status.slice(0, 64) } : {}),
    ...(pid !== undefined ? { pid } : {}),
  } : undefined;
}

function findRecord(value: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const normalizedKeys = new Set(keys.map(normalizeKey));
  for (const [key, nested] of Object.entries(value)) {
    if (!normalizedKeys.has(normalizeKey(key))) continue;
    if (isRecord(nested)) {
      if (firstString(nested, ["status", "state", "connection"]) !== undefined || firstNumber(nested, ["pid", "process_pid"]) !== undefined) {
        return nested;
      }
      const firstNested = Object.values(nested).find(isRecord);
      if (firstNested) return firstNested;
      return nested;
    }
    if (Array.isArray(nested)) {
      const firstNested = nested.find(isRecord);
      if (firstNested) return firstNested;
    }
  }
  return undefined;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, nested] of Object.entries(value)) {
    if (wanted.has(normalizeKey(key)) && typeof nested === "string") return nested;
  }
  return undefined;
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, nested] of Object.entries(value)) {
    if (wanted.has(normalizeKey(key)) && typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

function firstBoolean(value: Record<string, unknown>, keys: string[]): boolean | undefined {
  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, nested] of Object.entries(value)) {
    if (wanted.has(normalizeKey(key)) && typeof nested === "boolean") return nested;
  }
  return undefined;
}

function firstTimestamp(value: Record<string, unknown>, keys: string[]): string | undefined {
  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, nested] of Object.entries(value)) {
    if (!wanted.has(normalizeKey(key))) continue;
    if (typeof nested === "string") {
      const parsed = Date.parse(nested);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    if (typeof nested === "number" && Number.isFinite(nested)) return timestampFromEpoch(nested);
  }
  return undefined;
}

function timestampFromEpoch(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(millis).toISOString();
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return redactText((await response.text()).slice(0, maxBytes));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (bytes < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maxBytes - bytes;
      const value = chunk.value.length <= remaining ? chunk.value : chunk.value.slice(0, remaining);
      bytes += value.length;
      text += decoder.decode(value, { stream: bytes < maxBytes });
      if (value.length < chunk.value.length) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return redactText(text + decoder.decode()).slice(0, maxBytes);
  } finally {
    reader.releaseLock();
  }
}
