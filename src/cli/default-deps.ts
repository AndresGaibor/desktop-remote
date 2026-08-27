import { platform as nodePlatform } from "node:os";
import { readFile } from "node:fs/promises";
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
import { doctorTunnel, initializeTunnel } from "../platform/tunnel-install";
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
    prepareInstall: () => installProductionArtifacts(paths).then(() => undefined),
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
      const server = createMcpServer(new OperationIpcClient(paths.socketPath));
      const logger = new RotatingDaemonLog(join(paths.logsDir, "mcp.log"));
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
