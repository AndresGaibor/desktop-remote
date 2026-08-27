import type { DoctorReport } from "../doctor/doctor";

export type IncidentBoundary =
  | "NO_ACTIVE_LOCAL_INCIDENT"
  | "CHATGPT_HOST_BEFORE_MCP"
  | "MCP_BACKPRESSURE"
  | "MCP_RUNTIME_FAILURE"
  | "DAEMON_FAILURE"
  | "TUNNEL_FAILURE"
  | "CONTROL_PLANE_STALE"
  | "SCHEMA_DRIFT"
  | "LOCAL_RUNTIME_UNHEALTHY"
  | "INDETERMINATE";

export type IncidentConfidence = "high" | "medium" | "low";
export interface IncidentEvidence { code: string; detail: string; }
export interface IncidentInput {
  timestamp: string;
  incidentAt?: string;
  daemon: { alive: boolean; serviceLoaded?: boolean; serviceActive?: boolean };
  mcp: { reachable: boolean; lifecycle?: Partial<NonNullable<DoctorReport["mcp"]["lifecycle"]>>; backpressure?: Partial<NonNullable<DoctorReport["mcp"]["backpressure"]>> };
  tunnel: { healthy: boolean; healthzOk?: boolean; readyzOk?: boolean; queueDepth?: number; queueCapacity?: number; workersActive?: number; workersCapacity?: number };
  controlPlane: { stale: boolean };
  schema: { drift: boolean };
  localHealthy?: boolean;
}
export interface IncidentDiagnosis {
  timestamp: string;
  incidentAt: string | null;
  boundary: IncidentBoundary;
  confidence: IncidentConfidence;
  summary: string;
  evidence: IncidentEvidence[];
}
export interface IncidentOptions { incidentAt?: string; sinceMs?: number; }

export function classifyIncident(input: IncidentInput): IncidentDiagnosis {
  const evidence: IncidentEvidence[] = [];
  const add = (code: string, detail: string) => evidence.push({ code, detail });
  const incidentAt = input.incidentAt ? Date.parse(input.incidentAt) : undefined;
  const lastCall = input.mcp.lifecycle?.lastToolsCallAt;
  const backpressure = input.mcp.backpressure;

  let boundary: IncidentBoundary;
  let confidence: IncidentConfidence;
  let summary: string;
  if (input.schema.drift) {
    boundary = "SCHEMA_DRIFT"; confidence = "high"; summary = "MCP schema drift was detected."; add("SCHEMA_DRIFT", "Current and stored MCP schema hashes differ.");
  } else if (!input.daemon.alive || input.daemon.serviceLoaded === false || input.daemon.serviceActive === false) {
    boundary = "DAEMON_FAILURE"; confidence = "high"; summary = "The Desktop Remote daemon is not healthy."; add("DAEMON_UNHEALTHY", "Daemon process or loaded service is unavailable.");
  } else if (!input.mcp.reachable) {
    boundary = "MCP_RUNTIME_FAILURE"; confidence = "high"; summary = "The local MCP runtime is not reachable."; add("MCP_UNREACHABLE", "Daemon is alive but MCP is unreachable.");
  } else if (!input.tunnel.healthy || input.tunnel.healthzOk === false || input.tunnel.readyzOk === false) {
    boundary = "TUNNEL_FAILURE"; confidence = "high"; summary = "The local tunnel is unhealthy."; add("TUNNEL_UNHEALTHY", "Tunnel health or readiness probe failed.");
  } else if (input.controlPlane.stale) {
    boundary = "CONTROL_PLANE_STALE"; confidence = "high"; summary = "The local tunnel is alive but its control plane is stale."; add("CONTROL_PLANE_STALE", "Control-plane polling is stale.");
  } else if (backpressure && ((backpressure.queueLimit !== undefined && backpressure.queued !== undefined && backpressure.queued >= backpressure.queueLimit) || (backpressure.rejected ?? 0) > 0 || (backpressure.queueTimeouts ?? 0) > 0)) {
    const queued = backpressure.queued ?? 0;
    const queueLimit = backpressure.queueLimit ?? 0;
    const current = queueLimit > 0 && queued >= queueLimit;
    boundary = "MCP_BACKPRESSURE"; confidence = current ? "high" : "medium";
    summary = current ? "MCP is saturated right now." : "MCP backpressure has occurred since this runtime started.";
    add(current ? "MCP_SATURATED" : "MCP_HISTORICAL_BACKPRESSURE", current ? `MCP queue is full at ${queued}/${queueLimit}.` : "Rejected requests or queue timeouts were recorded.");
  } else if (incidentAt !== undefined && Number.isFinite(incidentAt) && lastCall !== undefined && lastCall < incidentAt - 5_000) {
    boundary = "CHATGPT_HOST_BEFORE_MCP"; confidence = "high"; summary = "The local runtime was healthy; the call likely failed before reaching MCP.";
    add("MCP_LAST_CALL_BEFORE_INCIDENT", `Last MCP tools/call was ${Math.round((incidentAt - lastCall) / 1000)} seconds before reported incident.`);
    add("LOCAL_RUNTIME_HEALTHY", "Daemon, MCP and tunnel are locally healthy.");
  } else if (input.localHealthy === false) {
    boundary = "LOCAL_RUNTIME_UNHEALTHY"; confidence = "medium"; summary = "The local runtime is unhealthy, but no single failure boundary was conclusive.";
  } else if (incidentAt === undefined) {
    boundary = "NO_ACTIVE_LOCAL_INCIDENT"; confidence = "high"; summary = "Local runtime is healthy and not saturated.";
    add("LOCAL_RUNTIME_HEALTHY", "Daemon, MCP and tunnel are locally healthy.");
    if (backpressure) add("NO_BACKPRESSURE", `MCP queue is ${backpressure.queued}/${backpressure.queueLimit} with zero current saturation.`);
  } else {
    boundary = "INDETERMINATE"; confidence = "low"; summary = "Available local evidence does not identify a failure boundary.";
  }
  return { timestamp: input.timestamp, incidentAt: input.incidentAt ?? null, boundary, confidence, summary, evidence };
}

export function parseIncidentOptions(args: string[]): IncidentOptions {
  let result: IncidentOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--at") {
      if (result.incidentAt !== undefined || result.sinceMs !== undefined || !args[i + 1]) throw new Error("incident accepts exactly one --at or --since option");
      const value = args[++i]!;
      if (!Number.isFinite(Date.parse(value))) throw new Error("--at requires a valid ISO8601 timestamp");
      result.incidentAt = value;
    } else if (arg === "--since") {
      if (result.incidentAt !== undefined || result.sinceMs !== undefined || !args[i + 1]) throw new Error("incident accepts exactly one --at or --since option");
      const match = args[++i]!.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
      if (!match) throw new Error("--since requires a duration such as 500ms, 30s, 2m, or 1h");
      const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
      result.sinceMs = Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
      if (!Number.isFinite(result.sinceMs) || result.sinceMs <= 0) throw new Error("--since must be positive");
    } else throw new Error(`unknown incident option: ${arg}`);
  }
  return result;
}

export function incidentInputFromDoctor(report: DoctorReport, options: IncidentOptions = {}, now = Date.now()): IncidentInput {
  const incidentAt = options.incidentAt ?? (options.sinceMs !== undefined ? new Date(now - options.sinceMs).toISOString() : undefined);
  return {
    timestamp: report.timestamp, incidentAt,
    daemon: { alive: report.daemon.alive, serviceLoaded: report.daemon.service?.loaded, serviceActive: report.daemon.service?.active },
    mcp: { reachable: report.mcp.reachable, lifecycle: report.mcp.lifecycle, backpressure: report.mcp.backpressure },
    tunnel: { healthy: report.tunnel.healthy, healthzOk: report.tunnel.healthz?.ok, readyzOk: report.tunnel.readyz?.ok, queueDepth: report.tunnel.selected.queue?.depth, queueCapacity: report.tunnel.selected.queue?.capacity, workersActive: report.tunnel.selected.workers?.active, workersCapacity: report.tunnel.selected.workers?.capacity },
    controlPlane: { stale: report.controlPlane.stale }, schema: { drift: report.schemaHash.drift }, localHealthy: report.local.healthy,
  };
}
