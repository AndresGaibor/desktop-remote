export type RecoveryAction = "healthy" | "observe" | "restart_tunnel" | "circuit_open";

export interface RecoveryLocalObservation {
  configured?: boolean;
  liveness: boolean;
  readiness: boolean;
  processAlive?: boolean;
  stuck?: boolean;
}

export interface RecoveryControlPlaneObservation {
  reachable?: boolean;
  stale?: boolean;
}

export interface RecoveryObservation {
  now: number;
  local: RecoveryLocalObservation;
  controlPlane?: RecoveryControlPlaneObservation;
}

export interface RecoveryHistory {
  restartTimes: number[];
}

export interface RecoveryPolicyOptions {
  maxRestarts?: number;
  windowMs?: number;
  cooldownMs?: number;
  healthyResetMs?: number;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  history: RecoveryHistory;
}

export const DEFAULT_RECOVERY_POLICY: Required<RecoveryPolicyOptions> = {
  maxRestarts: 3,
  windowMs: 10 * 60 * 1_000,
  cooldownMs: 60 * 1_000,
  healthyResetMs: 5 * 60 * 1_000,
};

export function evaluateRecovery(
  observation: RecoveryObservation,
  history: Partial<RecoveryHistory> = {},
  options: RecoveryPolicyOptions = {},
): RecoveryDecision {
  const policy = { ...DEFAULT_RECOVERY_POLICY, ...options };
  const now = observation.now;
  const recentRestarts = (history.restartTimes ?? [])
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= policy.windowMs)
    .slice(-Math.max(0, Math.floor(policy.maxRestarts)));
  const nextHistory: RecoveryHistory = { restartTimes: recentRestarts };

  if (observation.local.configured === false) {
    return { action: "observe", reason: "tunnel is not configured; no repair is safe", history: nextHistory };
  }

  if (isLocallyHealthy(observation.local)) {
    if (observation.controlPlane?.stale || observation.controlPlane?.reachable === false) {
      return {
        action: "observe",
        reason: controlPlaneOnlyReason(observation.controlPlane),
        history: nextHistory,
      };
    }
    return {
      action: "healthy",
      reason: "local tunnel liveness and readiness are healthy",
      history: hasBeenHealthyLongEnough(observation, recentRestarts, policy.healthyResetMs)
        ? { restartTimes: [] }
        : nextHistory,
    };
  }

  if (!isLocallyRepairable(observation.local)) {
    return {
      action: "observe",
      reason: controlPlaneOnlyReason(observation.controlPlane),
      history: nextHistory,
    };
  }

  if (recentRestarts.length >= Math.max(0, Math.floor(policy.maxRestarts))) {
    return {
      action: "circuit_open",
      reason: `restart budget exhausted: ${recentRestarts.length} attempts in ${policy.windowMs}ms`,
      history: nextHistory,
    };
  }

  const lastRestartAt = recentRestarts.at(-1);
  if (lastRestartAt !== undefined && now - lastRestartAt < policy.cooldownMs) {
    return {
      action: "observe",
      reason: `restart cooldown active for ${policy.cooldownMs - (now - lastRestartAt)}ms`,
      history: nextHistory,
    };
  }

  return {
    action: "restart_tunnel",
    reason: localFailureReason(observation.local),
    history: { restartTimes: [...recentRestarts, now] },
  };
}

function isLocallyHealthy(local: RecoveryLocalObservation): boolean {
  return local.liveness && local.readiness && local.processAlive !== false && local.stuck !== true;
}

function isLocallyRepairable(local: RecoveryLocalObservation): boolean {
  return local.stuck === true || !local.liveness || local.processAlive === false;
}

function localFailureReason(local: RecoveryLocalObservation): string {
  if (local.stuck) return "local tunnel diagnostics prove the tunnel is stuck";
  if (local.processAlive === false) return "local tunnel process is not alive";
  return "local tunnel liveness probe failed";
}

function controlPlaneOnlyReason(controlPlane: RecoveryControlPlaneObservation | undefined): string {
  if (controlPlane?.stale || controlPlane?.reachable === false) {
    return "control plane is stale or unavailable, but no locally repairable tunnel failure was proven";
  }
  return "tunnel is locally alive but not ready; no locally repairable failure was proven";
}

function hasBeenHealthyLongEnough(
  observation: RecoveryObservation,
  restartTimes: number[],
  healthyResetMs: number,
): boolean {
  const lastRestartAt = restartTimes.at(-1);
  return lastRestartAt === undefined || observation.now - lastRestartAt >= healthyResetMs;
}
