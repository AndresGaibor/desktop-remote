import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactText } from "../logging/redactor";
import { writeAtomicJson } from "../platform/atomic-file";
import type { DesktopRemotePaths } from "../platform/paths";
import { runDoctor, type DoctorDependencies } from "./doctor";
import {
  evaluateRecovery,
  type RecoveryDecision,
  type RecoveryHistory,
  type RecoveryObservation,
  type RecoveryPolicyOptions,
} from "./recovery-policy";

const RECOVERY_STATE_FILE = "recovery-state.json";
const MAX_STORED_RESTART_TIMES = 32;

export interface RepairTunnelOptions {
  collect: () => Promise<DoctorDependencies>;
  restartTunnel: () => Promise<boolean | void>;
  now?: () => number;
  policy?: RecoveryPolicyOptions;
}

export interface RepairTunnelResult {
  action: RecoveryDecision["action"];
  reason: string;
  message: string;
}

export async function repairTunnel(
  paths: DesktopRemotePaths,
  options: RepairTunnelOptions,
): Promise<RepairTunnelResult> {
  const now = options.now ?? Date.now;
  const historyPath = join(paths.appSupportDir, RECOVERY_STATE_FILE);
  const history = await readRecoveryHistory(historyPath);
  const report = await runDoctor("json", await options.collect());
  const observation: RecoveryObservation = {
    now: now(),
    local: {
      configured: report.tunnel.baseUrl === null ? false : true,
      liveness: report.tunnel.selected.liveness,
      readiness: report.tunnel.selected.readiness,
    },
    controlPlane: report.controlPlane,
  };
  const decision = evaluateRecovery(observation, history, options.policy);

  if (decision.action === "restart_tunnel") {
    let restarted: boolean | void;
    try {
      restarted = await options.restartTunnel();
    } catch (error) {
      await writeRecoveryHistory(historyPath, decision.history);
      throw new Error(`Tunnel repair failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
    }
    if (restarted === false) {
      return {
        action: "observe",
        reason: "no configured tunnel service is available to restart",
        message: "No configured tunnel service was found; observing without a restart",
      };
    }
    await writeRecoveryHistory(historyPath, decision.history);
    return {
      action: decision.action,
      reason: decision.reason,
      message: `Tunnel repair requested: ${decision.reason}`,
    };
  }

  await writeRecoveryHistory(historyPath, decision.history);
  return {
    action: decision.action,
    reason: decision.reason,
    message: decision.action === "healthy"
      ? "Tunnel is locally healthy; no repair needed"
      : `No tunnel restart performed: ${decision.reason}`,
  };
}

async function readRecoveryHistory(path: string): Promise<RecoveryHistory> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { restartTimes?: unknown };
    const restartTimes = Array.isArray(parsed.restartTimes)
      ? parsed.restartTimes.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).slice(-MAX_STORED_RESTART_TIMES)
      : [];
    return { restartTimes };
  } catch {
    return { restartTimes: [] };
  }
}

async function writeRecoveryHistory(path: string, history: RecoveryHistory): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeAtomicJson(path, { restartTimes: history.restartTimes.slice(-MAX_STORED_RESTART_TIMES) }, 0o600);
  await chmod(path, 0o600);
}
