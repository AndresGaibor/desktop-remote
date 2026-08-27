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
  configValid: boolean;
  configErrors: string[];
}

export interface DoctorReport {
  daemon: {
    alive: boolean;
    pid?: number;
  };
  mcp: {
    reachable: boolean;
  };
  tunnel: {
    healthy: boolean;
    detail?: string;
  };
  disk: {
    freeBytes: bigint;
    totalBytes: bigint;
  };
  logs: {
    recentErrors: string[];
  };
  schemaHash: {
    current: string;
    drift: boolean;
  };
  config: {
    valid: boolean;
    errors?: string[];
  };
  timestamp: string;
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

  const schemaHashDrift = schemaHashCurrent !== schemaHashStored;
  const healthy = daemonAlive &&
    mcpReachable &&
    tunnelHealthy &&
    recentErrors.length === 0 &&
    configValid &&
    !schemaHashDrift;

  return {
    daemon: { alive: daemonAlive, pid: daemonPid },
    mcp: { reachable: mcpReachable },
    tunnel: { healthy: tunnelHealthy, detail: tunnelDetail },
    disk: { freeBytes: diskFreeBytes, totalBytes: diskTotalBytes },
    logs: { recentErrors: [...recentErrors] },
    schemaHash: { current: schemaHashCurrent, drift: schemaHashDrift },
    config: { valid: configValid, errors: configErrors.length > 0 ? [...configErrors] : undefined },
    timestamp: new Date().toISOString(),
    healthy,
  };
}

function formatText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("=== Desktop Remote Doctor Report ===");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Overall Health: ${report.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  lines.push("");
  lines.push("--- Daemon ---");
  lines.push(`  Alive: ${report.daemon.alive ? "yes" : "no"}`);
  if (report.daemon.pid !== undefined) lines.push(`  PID: ${report.daemon.pid}`);
  lines.push("");
  lines.push("--- MCP ---");
  lines.push(`  Reachable: ${report.mcp.reachable ? "yes" : "no"}`);
  lines.push("");
  lines.push("--- Tunnel ---");
  lines.push(`  Healthy: ${report.tunnel.healthy ? "yes" : "no"}`);
  if (report.tunnel.detail) lines.push(`  Detail: ${report.tunnel.detail}`);
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
