import { readFile as nodeReadFile } from "node:fs/promises";
import { redactText } from "../logging/redactor";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_BODY_CHARS = 256;
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

type ReadFile = (path: string, encoding: "utf8") => Promise<string>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TunnelHealthProbeDependencies {
  readFile?: ReadFile;
  fetch?: Fetch;
  timeoutMs?: number;
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
    const body = (await response.text()).slice(0, MAX_BODY_CHARS);
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
