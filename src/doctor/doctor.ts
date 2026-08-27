import { redactText } from "../logging/redactor";
import { describeSchemaHash } from "../config/schema-hash";
import type { TunnelDiagnosticEndpoint, TunnelDiagnostics, TunnelSelectedDiagnostics } from "../platform/tunnel-health";

const MAX_RECENT_ERRORS = 10;
const MAX_DIAGNOSTIC_TEXT = 256;

export interface DoctorBuildMetadata {
  layout?: "single" | "split";
  cli?: string;
  daemon?: string;
  daemonArgs?: string[];
  version?: string;
  cliPresent?: boolean;
  daemonPresent?: boolean;
}

export interface DoctorServiceMetadata {
  loaded?: boolean;
  enabled?: boolean;
  active?: boolean;
  pid?: number;
  lastExitCode?: number;
}

export interface DoctorDependencies {
  daemonAlive: boolean;
  daemonPid?: number;
  mcpReachable: boolean;
  tunnelHealthy: boolean;
  tunnelDetail?: string;
  diskFreeBytes: bigint;
  diskTotalBytes: bigint;
  recentErrors: string[];
  schemaHashCurrent: string;
  schemaHashStored: string;
  mcpCatalogFingerprint?: string;
  configValid: boolean;
  configErrors: string[];
  tunnelDiagnostics?: TunnelDiagnostics;
  buildMetadata?: DoctorBuildMetadata;
  logPaths?: Record<string, boolean>;
  serviceStatus?: DoctorServiceMetadata;
}

export interface DoctorReport {
  daemon: {
    alive: boolean;
    pid?: number;
    service?: DoctorServiceMetadata;
  };
  mcp: {
    reachable: boolean;
    catalogFingerprint?: string;
    status?: string;
    pid?: number;
    channel?: { status?: string; pid?: number };
  };
  tunnel: {
    healthy: boolean;
    detail?: string;
    baseUrl?: string | null;
    healthz?: { ok: boolean; status: number | null };
    readyz?: { ok: boolean; status: number | null };
    api: {
      status: TunnelDiagnosticEndpoint;
      system: TunnelDiagnosticEndpoint;
    };
    metrics: TunnelDiagnosticEndpoint;
    selected: TunnelSelectedDiagnostics;
  };
  local: {
    healthy: boolean;
    daemon: boolean;
    mcp: boolean;
    tunnel: boolean;
  };
  controlPlane: {
    status: "healthy" | "stale" | "unavailable" | "unknown";
    stale: boolean;
    reachable?: boolean;
    pollingAgeMs?: number;
  };
  disk: {
    freeBytes: bigint;
    totalBytes: bigint;
  };
  logs: {
    recentErrors: string[];
    paths: Record<string, boolean>;
  };
  schemaHash: {
    current: string;
    stored: string;
    drift: boolean;
  };
  config: {
    valid: boolean;
    errors?: string[];
  };
  timestamp: string;
  build: DoctorBuildMetadata;
  healthy: boolean;
}

export async function runDoctor(format: "json", deps: DoctorDependencies): Promise<DoctorReport>;
export async function runDoctor(format: "text", deps: DoctorDependencies): Promise<string>;
export async function runDoctor(
  format: "json" | "text",
  deps: DoctorDependencies,
): Promise<DoctorReport | string> {
  const report = buildReport(deps);

  if (format === "text") {
    return formatText(report);
  }

  return report;
}

export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, (key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  }, 2);
}

function buildReport(deps: DoctorDependencies): DoctorReport {
  const { daemonAlive, daemonPid, mcpReachable, tunnelHealthy, tunnelDetail,
    diskFreeBytes, diskTotalBytes, recentErrors,
    schemaHashCurrent, schemaHashStored, configValid, configErrors } = deps;

  const schemaHash = describeSchemaHash(schemaHashCurrent, schemaHashStored);
  const diagnostics = deps.tunnelDiagnostics;
  const selected = diagnostics?.selected ?? { liveness: tunnelHealthy, readiness: tunnelHealthy };
  const controlPlane = describeControlPlane(selected);
  const localHealthy = daemonAlive &&
    mcpReachable &&
    tunnelHealthy &&
    recentErrors.length === 0 &&
    configValid &&
    !schemaHash.drift;
  const healthy = localHealthy && !controlPlane.stale;
  const mcpStatus = selected.mcp;

  return {
    daemon: { alive: daemonAlive, pid: daemonPid, service: deps.serviceStatus },
    mcp: {
      reachable: mcpReachable,
      ...(deps.mcpCatalogFingerprint ? { catalogFingerprint: deps.mcpCatalogFingerprint } : {}),
      ...(mcpStatus?.status !== undefined ? { status: mcpStatus.status } : {}),
      ...(mcpStatus?.pid !== undefined ? { pid: mcpStatus.pid } : {}),
      ...(selected.channel ? { channel: selected.channel } : {}),
    },
    tunnel: {
      healthy: tunnelHealthy,
      detail: tunnelDetail,
      baseUrl: diagnostics?.baseUrl,
      healthz: diagnostics ? { ok: diagnostics.healthz.ok, status: diagnostics.healthz.status } : undefined,
      readyz: diagnostics ? { ok: diagnostics.readyz.ok, status: diagnostics.readyz.status } : undefined,
      api: diagnostics?.api ?? { status: unavailableEndpoint(), system: unavailableEndpoint() },
      metrics: diagnostics?.metrics ?? unavailableEndpoint(),
      selected,
    },
    local: { healthy: localHealthy, daemon: daemonAlive, mcp: mcpReachable, tunnel: tunnelHealthy },
    controlPlane,
    disk: { freeBytes: diskFreeBytes, totalBytes: diskTotalBytes },
    logs: {
      recentErrors: recentErrors.slice(0, MAX_RECENT_ERRORS).map(sanitizeDiagnosticText),
      paths: sanitizeLogPaths(deps.logPaths),
    },
    schemaHash,
    config: {
      valid: configValid,
      errors: configErrors.length > 0 ? configErrors.slice(0, MAX_RECENT_ERRORS).map(sanitizeDiagnosticText) : undefined,
    },
    timestamp: new Date().toISOString(),
    build: sanitizeBuildMetadata(deps.buildMetadata),
    healthy,
  };
}

function formatText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("=== Desktop Remote Doctor Report ===");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Overall Health: ${report.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  lines.push(`Local Health: ${report.local.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  lines.push(`Control Plane: ${report.controlPlane.status.toUpperCase()}`);
  lines.push("");
  lines.push("--- Daemon ---");
  lines.push(`  Alive: ${report.daemon.alive ? "yes" : "no"}`);
  if (report.daemon.pid !== undefined) lines.push(`  PID: ${report.daemon.pid}`);
  lines.push("");
  lines.push("--- MCP ---");
  lines.push(`  Reachable: ${report.mcp.reachable ? "yes" : "no"}`);
  if (report.mcp.status) lines.push(`  Status: ${report.mcp.status}`);
  if (report.mcp.pid !== undefined) lines.push(`  PID: ${report.mcp.pid}`);
  if (report.mcp.channel) lines.push(`  Channel: ${report.mcp.channel.status ?? "unknown"}`);
  lines.push("");
  lines.push("--- Tunnel ---");
  lines.push(`  Healthy: ${report.tunnel.healthy ? "yes" : "no"}`);
  if (report.tunnel.detail) lines.push(`  Detail: ${report.tunnel.detail}`);
  if (report.tunnel.selected.polling?.ageMs !== undefined) {
    lines.push(`  Polling age: ${report.tunnel.selected.polling.ageMs}ms`);
  }
  lines.push("");
  lines.push("--- Disk ---");
  lines.push(`  Free: ${formatBytes(report.disk.freeBytes)}`);
  lines.push(`  Total: ${formatBytes(report.disk.totalBytes)}`);
  lines.push("");
  lines.push("--- Logs (Recent Errors) ---");
  if (report.logs.recentErrors.length === 0) {
    lines.push("  No recent errors");
  } else {
    for (const err of report.logs.recentErrors) {
      lines.push(`  - ${err}`);
    }
  }
  lines.push("");
  lines.push("--- Schema Hash ---");
  lines.push(`  Current: ${report.schemaHash.current}`);
  lines.push(`  Stored: ${report.schemaHash.stored || "missing"}`);
  lines.push(`  Drift: ${report.schemaHash.drift ? "DETECTED" : "none"}`);
  lines.push("");
  lines.push("--- Config ---");
  lines.push(`  Valid: ${report.config.valid ? "yes" : "no"}`);
  if (report.config.errors && report.config.errors.length > 0) {
    for (const err of report.config.errors) {
      lines.push(`  Error: ${err}`);
    }
  }

  return lines.join("\n");
}

function describeControlPlane(selected: TunnelSelectedDiagnostics): DoctorReport["controlPlane"] {
  const reachable = selected.controlPlane?.reachable;
  const stale = selected.controlPlane?.stale === true || selected.polling?.stale === true;
  const status = stale ? "stale" : reachable === false ? "unavailable" :
    reachable === true || selected.polling?.lastSuccessAt !== undefined ? "healthy" : "unknown";
  return {
    status,
    stale,
    ...(reachable !== undefined ? { reachable } : {}),
    ...(selected.polling?.ageMs !== undefined ? { pollingAgeMs: selected.polling.ageMs } : {}),
  };
}

function unavailableEndpoint(): TunnelDiagnosticEndpoint {
  return { available: false, status: null, error: "unavailable" };
}

function sanitizeBuildMetadata(metadata: DoctorBuildMetadata | undefined): DoctorBuildMetadata {
  if (!metadata) return {};
  return {
    ...(metadata.layout ? { layout: metadata.layout } : {}),
    ...(metadata.cli ? { cli: sanitizeDiagnosticText(metadata.cli) } : {}),
    ...(metadata.daemon ? { daemon: sanitizeDiagnosticText(metadata.daemon) } : {}),
    ...(metadata.daemonArgs ? { daemonArgs: metadata.daemonArgs.slice(0, 16).map(sanitizeDiagnosticText) } : {}),
    ...(metadata.version ? { version: sanitizeDiagnosticText(metadata.version) } : {}),
    ...(metadata.cliPresent !== undefined ? { cliPresent: metadata.cliPresent } : {}),
    ...(metadata.daemonPresent !== undefined ? { daemonPresent: metadata.daemonPresent } : {}),
  };
}

function sanitizeDiagnosticText(value: string): string {
  return redactText(value).slice(0, MAX_DIAGNOSTIC_TEXT);
}

function sanitizeLogPaths(paths: Record<string, boolean> | undefined): Record<string, boolean> {
  if (!paths) return {};
  return Object.fromEntries(
    Object.entries(paths).slice(0, 16).map(([path, exists]) => [sanitizeDiagnosticText(path), Boolean(exists)]),
  );
}

function formatBytes(bytes: bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}
