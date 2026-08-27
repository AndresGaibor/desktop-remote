import { readFile } from "node:fs/promises";

export interface McpLifecycleDiagnostics {
  runtimeInstanceId: string;
  connectionId?: string;
  currentSchemaHash?: string;
  initializeCount?: number;
  toolsListCount?: number;
  toolsCallCount?: number;
  toolsCallSuccessCount?: number;
  toolsCallFailureCount?: number;
  activeRequests?: number;
  lastInitializeAt?: number;
  lastToolsListAt?: number;
  lastToolsCallAt?: number;
  observedAt: string;
}

export interface McpBackpressureDiagnostics {
  active: number;
  activeLimit: number;
  queued: number;
  queueLimit: number;
  rejected: number;
  queueTimeouts: number;
  observedAt: string;
}

export interface McpRuntimeDiagnostics {
  lifecycle?: McpLifecycleDiagnostics;
  backpressure?: McpBackpressureDiagnostics;
}

export function parseMcpRuntimeDiagnostics(lines: string[]): McpRuntimeDiagnostics {
  let lifecycle: McpLifecycleDiagnostics | undefined;
  let backpressure: McpBackpressureDiagnostics | undefined;

  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const entry = asRecord(record);
    if (!entry) continue;
    const timestamp = validTimestamp(entry.timestamp);
    const message = typeof entry.message === "string" ? entry.message : undefined;
    const data = asRecord(entry.data);
    if (!timestamp || !message || !data) continue;

    if (message.startsWith("mcp.lifecycle.")) {
      const candidate = parseLifecycle(data, timestamp);
      if (candidate && (!lifecycle || Date.parse(candidate.observedAt) >= Date.parse(lifecycle.observedAt))) lifecycle = candidate;
    } else if (message === "mcp.backpressure.state") {
      const candidate = parseBackpressure(data, timestamp);
      if (candidate && (!backpressure || Date.parse(candidate.observedAt) >= Date.parse(backpressure.observedAt))) backpressure = candidate;
    }
  }

  return {
    ...(lifecycle ? { lifecycle } : {}),
    ...(backpressure ? { backpressure } : {}),
  };
}

export async function readMcpRuntimeDiagnostics(paths: string[]): Promise<McpRuntimeDiagnostics> {
  const lines: string[] = [];
  for (const path of paths) {
    try {
      lines.push(...(await readFile(path, "utf8")).split("\n").filter(Boolean));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return parseMcpRuntimeDiagnostics(lines);
}

function parseLifecycle(data: Record<string, unknown>, observedAt: string): McpLifecycleDiagnostics | undefined {
  if (typeof data.runtimeInstanceId !== "string" || data.runtimeInstanceId.length === 0) return undefined;
  return {
    runtimeInstanceId: data.runtimeInstanceId,
    ...(typeof data.connectionId === "string" ? { connectionId: data.connectionId } : {}),
    ...(typeof data.currentSchemaHash === "string" ? { currentSchemaHash: data.currentSchemaHash } : {}),
    ...optionalNumber(data, "initializeCount"),
    ...optionalNumber(data, "toolsListCount"),
    ...optionalNumber(data, "toolsCallCount"),
    ...optionalNumber(data, "toolsCallSuccessCount"),
    ...optionalNumber(data, "toolsCallFailureCount"),
    ...optionalNumber(data, "activeRequests"),
    ...optionalNumber(data, "lastInitializeAt"),
    ...optionalNumber(data, "lastToolsListAt"),
    ...optionalNumber(data, "lastToolsCallAt"),
    observedAt,
  };
}

function parseBackpressure(data: Record<string, unknown>, observedAt: string): McpBackpressureDiagnostics | undefined {
  const keys = ["active", "activeLimit", "queued", "queueLimit", "rejected", "queueTimeouts"] as const;
  if (!keys.every((key) => isNonNegativeNumber(data[key]))) return undefined;
  return {
    active: data.active as number,
    activeLimit: data.activeLimit as number,
    queued: data.queued as number,
    queueLimit: data.queueLimit as number,
    rejected: data.rejected as number,
    queueTimeouts: data.queueTimeouts as number,
    observedAt,
  };
}

function optionalNumber(data: Record<string, unknown>, key: string): Record<string, number> {
  const value = data[key];
  return isNonNegativeNumber(value) ? { [key]: value } : {};
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}
