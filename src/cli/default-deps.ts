import "./zod-lazy-patch";
import { platform as nodePlatform } from "node:os";
import { open, readFile, stat, statfs } from "node:fs/promises";
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
import { installProductionArtifacts, rollbackInstalledBuild, updateLocalArtifacts } from "../platform/install";
import { getDesktopRemotePaths, type Platform } from "../platform/paths";
import { doctorTunnel, initializeTunnel, restartTunnelServiceIfConfigured } from "../platform/tunnel-install";
import { probeTunnelDiagnostics, probeTunnelHealth } from "../platform/tunnel-health";
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
import { runDoctor, type DoctorDependencies, type DoctorServiceMetadata, formatDoctorReportJson } from "../doctor/doctor";
import { createSupportBundle } from "../doctor/support-bundle";
import { computeToolSchemaHash } from "../config/schema-hash";
import { computeMcpToolCatalogHash, createToolDefinitions } from "../mcp/tools";
import { ConfigStore, defaultConfig } from "../config/store";
import { readMcpRuntimeDiagnostics } from "../doctor/mcp-runtime-diagnostics";

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
  const restartTunnel = async () => {
    await restartTunnelServiceIfConfigured(paths, { platform, run: runCommand });
  };
  const service = new ServiceController({
    paths,
    manager,
    requestStatus,
    healthCheck: async () => {
      const status = await requestStatus();
      if (["stopped", "recovering", "degraded"].includes(status.state)) {
        throw new Error(`Desktop Remote health gate rejected daemon state: ${status.state}`);
      }
    },
    prepareInstall: async () => {
      await installProductionArtifacts(paths);
      await restartTunnel();
    },
    onBeforeManagerRestart: restartTunnel,
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
      const data = await collectDoctorData(paths, manager);
      if (format === "json") {
        const report = await runDoctor("json", data);
        process.stdout.write(`${formatDoctorReportJson(report)}\n`);
      } else {
        const text = await runDoctor("text", data);
        process.stdout.write(`${text}\n`);
      }
    },
    supportBundle: async (outputPath) => {
      const data = await collectDoctorData(paths, manager);
      const report = await runDoctor("json", data);
      const logFiles = await readSupportBundleLogs(paths);
      const target = outputPath ?? join(paths.appSupportDir, "support-bundles", `bundle-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      return (await createSupportBundle({ report, outputPath: target, logFiles })).path;
    },
    repair: async () => {
      const { repairTunnel } = await import("../doctor/repair");
      const servicePath = platform === "darwin" ? paths.tunnelLaunchAgentPath : paths.tunnelSystemdUserUnitPath;
      const result = await repairTunnel(paths, {
        collect: () => collectDoctorData(paths, manager),
        restartTunnel: async () => {
          if (!servicePath || !await pathExists(servicePath)) return false;
          await restartTunnelServiceIfConfigured(paths, { platform, run: runCommand });
          return true;
        },
      });
      return result.message;
    },
    update: async () => {
      await service.updateLocal(
        async () => { await updateLocalArtifacts(paths); },
        async () => { await rollbackInstalledBuild(paths); },
      );
      process.stdout.write("Local checkout updated successfully; previous runtime retained and tunnel MCP reloaded before daemon health verification\n");
    },
    updateLocal: async () => {
      await service.updateLocal(
        async () => { await updateLocalArtifacts(paths); },
        async () => { await rollbackInstalledBuild(paths); },
      );
      process.stdout.write("Local checkout updated successfully; previous runtime retained and tunnel MCP reloaded before daemon health verification\n");
    },
    rollback: async () => {
      await service.rollback(async () => { await rollbackInstalledBuild(paths); });
      process.stdout.write("Runtime rolled back successfully; tunnel MCP reloaded before daemon health verification\n");
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

async function collectDoctorData(
  paths: ReturnType<typeof getDesktopRemotePaths>,
  serviceManager?: { status(): Promise<DoctorServiceMetadata> },
): Promise<DoctorDependencies> {
  const [daemonStatus, tunnelDiagnostics, diskSpace, recentErrors, logPaths, schemaHashInfo, configValidation, buildMetadata, serviceStatus, mcpRuntimeDiagnostics] = await Promise.all([
    checkDaemonAlive(paths),
    checkTunnelDiagnostics(paths),
    checkDiskSpace(paths.appSupportDir),
    readRecentErrors(paths),
    checkLogPaths(paths),
    checkSchemaHash(paths),
    validateConfig(paths),
    readBuildMetadata(paths),
    serviceManager ? readServiceStatus(serviceManager) : Promise.resolve(undefined),
    readMcpRuntimeDiagnostics([
      join(paths.logsDir, "mcp.log.2"),
      join(paths.logsDir, "mcp.log.1"),
      join(paths.logsDir, "mcp.log"),
    ]),
  ]);

  return {
    daemonAlive: daemonStatus.alive,
    daemonPid: daemonStatus.pid,
    mcpReachable: daemonStatus.alive,
    tunnelHealthy: tunnelDiagnostics.state === "ready",
    tunnelDetail: tunnelDiagnostics.state,
    tunnelDiagnostics,
    diskFreeBytes: diskSpace.freeBytes,
    diskTotalBytes: diskSpace.totalBytes,
    recentErrors,
    logPaths,
    schemaHashCurrent: schemaHashInfo.current,
    schemaHashStored: schemaHashInfo.stored,
    mcpCatalogFingerprint: computeMcpToolCatalogHash(createToolDefinitions()),
    configValid: configValidation.valid,
    configErrors: configValidation.errors,
    buildMetadata,
    serviceStatus,
    mcpRuntimeDiagnostics,
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

async function checkTunnelDiagnostics(paths: ReturnType<typeof getDesktopRemotePaths>) {
  try {
    return await probeTunnelDiagnostics(tunnelHealthUrlFile(paths.tunnelProfilePath));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      baseUrl: null,
      state: "unreachable" as const,
      healthz: { ok: false, status: null, error: detail },
      readyz: { ok: false, status: null, error: detail },
      api: {
        status: { available: false, status: null, error: detail },
        system: { available: false, status: null, error: detail },
      },
      metrics: { available: false, status: null, error: detail },
      selected: { liveness: false, readiness: false },
    };
  }
}

async function readBuildMetadata(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<NonNullable<DoctorDependencies["buildMetadata"]>> {
  const layout = await (async () => {
    try {
      const parsed = JSON.parse(await readFile(join(paths.binDir, "build-layout.json"), "utf8")) as Record<string, unknown>;
      if ((parsed.layout !== "single" && parsed.layout !== "split") || typeof parsed.cli !== "string" || typeof parsed.daemon !== "string") {
        throw new Error("invalid build metadata");
      }
      return {
        layout: parsed.layout,
        cli: parsed.cli,
        daemon: parsed.daemon,
        daemonArgs: Array.isArray(parsed.daemonArgs) ? parsed.daemonArgs.filter((arg): arg is string => typeof arg === "string") : [],
      } as const;
    } catch {
      return { layout: "single" as const, cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"] };
    }
  })();
  const [cliPresent, daemonPresent] = await Promise.all([
    pathExists(join(paths.binDir, layout.cli)),
    pathExists(join(paths.binDir, layout.daemon)),
  ]);
  return { ...layout, cliPresent, daemonPresent, version: "1.0.0" };
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function readServiceStatus(serviceManager: { status(): Promise<DoctorServiceMetadata> }): Promise<DoctorServiceMetadata | undefined> {
  try { return await serviceManager.status(); } catch { return undefined; }
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
            errors.push(typeof entry.message === "string" ? entry.message : String(entry.message ?? entry));
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

async function checkLogPaths(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<Record<string, boolean>> {
  const names = ["daemon.log.2", "daemon.log.1", "daemon.log", "mcp.log", "tunnel.stdout.log", "tunnel.stderr.log"];
  const result: Record<string, boolean> = {};
  for (const name of names) result[name] = await pathExists(join(paths.logsDir, name));
  return result;
}

async function readSupportBundleLogs(paths: ReturnType<typeof getDesktopRemotePaths>): Promise<Array<{ name: string; content: string }>> {
  const names = ["daemon.log.2", "daemon.log.1", "daemon.log", "mcp.log", "tunnel.stdout.log", "tunnel.stderr.log"];
  const files: Array<{ name: string; content: string }> = [];
  for (const name of names) {
    try {
      files.push({ name, content: await readBoundedTail(join(paths.logsDir, name), 32 * 1024) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

async function readBoundedTail(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  const length = Math.min(maxBytes, info.size);
  const offset = Math.max(0, info.size - length);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
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
