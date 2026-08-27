import "./zod-lazy-patch";
import { platform as nodePlatform } from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DesktopRemoteIpcClient } from "../client/ipc-client";
import { attachTui } from "../client/run-attach";
import { parseDaemonDevArgs, runDaemon } from "../daemon/run-daemon";
import { readDaemonLogs } from "../logging/read-logs";
import { readJsonlEvents } from "../logging/jsonl";
import { RotatingDaemonLog } from "../logging/rotating-log";
import { readDesiredState } from "../platform/desired-state";
import { DynamicUserServiceManager } from "../platform/dynamic-service-manager";
import { installProductionArtifacts } from "../platform/install";
import { getDesktopRemotePaths, type Platform } from "../platform/paths";
import { doctorTunnel, initializeTunnel, restartTunnelServiceIfConfigured } from "../platform/tunnel-install";
import { probeTunnelHealth } from "../platform/tunnel-health";
import { tunnelHealthUrlFile } from "../platform/tunnel-services";
import { runCommand } from "../platform/command-runner";
import { ServiceController } from "../platform/service-controller";
import { SessionStore } from "../session/store";
import type { TuiSessionSource } from "../client/session-source";
import { runPipeMode } from "./run-pipe";
import type { CliDependencies } from "./main";
import { createMcpServer } from "../mcp/server";
import { runMcpStdioServer } from "../mcp/run-stdio-server";
import { OperationIpcClient } from "../client/operation-ipc-client";
import { runDoctor, type DoctorDependencies, formatDoctorReportJson } from "../doctor/doctor";
import { computeToolSchemaHash } from "../config/schema-hash";
import { ConfigStore, defaultConfig } from "../config/store";

export function createDefaultCliDependencies(): CliDependencies {
  const paths = getDesktopRemotePaths();
  const platform = nodePlatform() as Platform;
  const manager = new DynamicUserServiceManager({ paths, run: runCommand, platform });
  const requestStatus = async () => {
    const client = new DesktopRemoteIpcClient({ socketPath: paths.socketPath });
    try {
      await client.connect("admin");
      return await client.requestStatus();
    } finally {
      await client.close();
    }
  };
  const service = new ServiceController({
    paths,
    manager,
    requestStatus,
    prepareInstall: async () => {
      await installProductionArtifacts(paths);
      await restartTunnelServiceIfConfigured(paths, { platform, run: runCommand });
    },
  });

  return {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readDesiredState: () => readDesiredState(paths.desiredStatePath),
    service,
    attach: async () => { await attachTui({ socketPath: paths.socketPath }); },
    replay: async (file) => replay(file),
    pipe: async () => { await runPipeMode({ verbose: false, maxLines: 15 }); },
    logs: async (follow) => { await readDaemonLogs(paths, follow, (text) => process.stdout.write(text)); },
    daemon: async (args) => {
      if (args.length === 1 && args[0] === "--probe") {
        process.stdout.write("desktop-remote daemon probe ok\n");
        return;
      }
      const dev = parseDaemonDevArgs(args);
      if (dev.command) { await runDaemon(dev); return; }
      await runDaemon({});
    },
    mcpServe: async () => {
      const logger = new RotatingDaemonLog(join(paths.logsDir, "mcp.log"));
      const server = createMcpServer(new OperationIpcClient(paths.socketPath), logger);
      await runMcpStdioServer({ server, transport: new StdioServerTransport(), logger });
    },
    tunnelInit: async (args) => {
      const tunnelId = optionValue(args, "--tunnel-id");
      const profilePath = optionValue(args, "--profile");
      const result = await initializeTunnel(paths, { tunnelId, profile: await readFile(profilePath, "utf8") });
      process.stdout.write(`Tunnel profile saved to ${result.profilePath}\nService definition written to ${result.servicePath}\n`);
    },
    tunnelDoctor: async () => {
      process.stdout.write(`${JSON.stringify(await doctorTunnel(paths), null, 2)}\n`);
    },
    tunnelStatus: async () => {
      const status = await probeTunnelHealth(tunnelHealthUrlFile(paths.tunnelProfilePath));
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    },
    doctor: async (format) => {
      const data = await collectDoctorData(paths);
      if (format === "json") {
        const report = await runDoctor("json", data);
        process.stdout.write(`${formatDoctorReportJson(report)}\n`);
      } else {
        const text = await runDoctor("text", data);
        process.stdout.write(`${text}\n`);
      }
    },
    update: async () => {
      const { buildAndPromoteWithBackup } = await import("../platform/install");
      await buildAndPromoteWithBackup(paths);
      await restartTunnelServiceIfConfigured(paths, { platform, run: runCommand });
      process.stdout.write("Binary updated successfully. Previous version backed up to .bak; tunnel MCP reloaded when configured\n");
    },
    rollback: async () => {
      const { rollbackBinary } = await import("../platform/install");
      await rollbackBinary(paths.binDir, "desktop-remote");
      process.stdout.write("Binary rolled back successfully\n");
    },
    writeOut: (text) => process.stdout.write(`${text}\n`),
    writeErr: (text) => process.stderr.write(`desktop-remote: ${text}\n`),
  };
}

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`tunnel init requires ${name}`);
  return value;
}

const REPLAY_SOURCE: TuiSessionSource = {
  start: async () => {},
  stop: async () => {},
  connectionState: () => "connected",
};

async function replay(file: string): Promise<void> {
  const events = await readJsonlEvents(file);
  const store = new SessionStore();
  for (const event of events) store.consume(event);
  const { runTui } = await import("../tui/run-tui");
  await runTui({ source: REPLAY_SOURCE, store });
}

async function collectDoctorData(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<DoctorDependencies> {
  const [daemonStatus, tunnelHealth, diskSpace, recentErrors, schemaHashInfo, configValidation] = await Promise.all([
    checkDaemonAlive(paths),
    checkTunnelHealth(paths),
    checkDiskSpace(paths.appSupportDir),
    readRecentErrors(paths),
    checkSchemaHash(paths),
    validateConfig(paths),
  ]);

  return {
    daemonAlive: daemonStatus.alive,
    daemonPid: daemonStatus.pid,
    mcpReachable: daemonStatus.alive,
    tunnelHealthy: tunnelHealth.healthy,
    tunnelDetail: tunnelHealth.detail,
    diskFreeBytes: diskSpace.freeBytes,
    diskTotalBytes: diskSpace.totalBytes,
    recentErrors,
    schemaHashCurrent: schemaHashInfo.current,
    schemaHashStored: schemaHashInfo.stored,
    configValid: configValidation.valid,
    configErrors: configValidation.errors,
  };
}

async function checkDaemonAlive(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<{ alive: boolean; pid?: number }> {
  const client = new DesktopRemoteIpcClient({ socketPath: paths.socketPath, requestTimeoutMs: 2000 });
  try {
    await client.connect("admin");
    const status = await client.requestStatus();
    return { alive: true, pid: status.childPid };
  } catch {
    return { alive: false };
  } finally {
    await client.close().catch(() => {});
  }
}

async function checkTunnelHealth(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<{ healthy: boolean; detail?: string }> {
  try {
    const status = await probeTunnelHealth(tunnelHealthUrlFile(paths.tunnelProfilePath));
    return {
      healthy: status.state === "ready",
      detail: status.state === "ready" ? "ready" : status.state,
    };
  } catch (error) {
    return { healthy: false, detail: error instanceof Error ? error.message : "unknown error" };
  }
}

async function checkDiskSpace(appSupportDir: string): Promise<{ freeBytes: bigint; totalBytes: bigint }> {
  try {
    const stats = await statfs(appSupportDir);
    return { freeBytes: BigInt(stats.bfree) * BigInt(stats.bsize), totalBytes: BigInt(stats.blocks) * BigInt(stats.bsize) };
  } catch {
    return { freeBytes: 0n, totalBytes: 0n };
  }
}

async function readRecentErrors(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<string[]> {
  const errors: string[] = [];
  const logFiles = ["daemon.log.2", "daemon.log.1", "daemon.log"];
  for (const name of logFiles) {
    try {
      const content = await readFile(join(paths.logsDir, name), "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.level === "error") {
            errors.push(entry.message || String(entry));
            if (errors.length >= 10) break;
          }
        } catch {
          if (line.toLowerCase().includes("error")) {
            errors.push(line);
            if (errors.length >= 10) break;
          }
        }
      }
      if (errors.length >= 10) break;
    } catch {
      // File may not exist, skip
    }
  }
  return errors;
}

async function checkSchemaHash(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<{ current: string; stored: string }> {
  const current = computeToolSchemaHash();
  const hashFilePath = join(paths.appSupportDir, "schema-hash.json");
  try {
    const stored = JSON.parse(await readFile(hashFilePath, "utf8")).hash as string;
    return { current, stored };
  } catch {
    return { current, stored: "" };
  }
}

async function validateConfig(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const defaultCfg = defaultConfig();
  try {
    const configPath = paths.configPath ?? join(paths.appSupportDir, "config.json");
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      errors.push("config is not a valid object");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`config read error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
