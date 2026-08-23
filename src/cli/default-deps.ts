import { platform as nodePlatform } from "node:os";
import { DesktopRemoteIpcClient } from "../client/ipc-client";
import { attachTui } from "../client/run-attach";
import { parseDaemonDevArgs, runDaemon } from "../daemon/run-daemon";
import { readDaemonLogs } from "../logging/read-logs";
import { readJsonlEvents } from "../logging/jsonl";
import { readDesiredState } from "../platform/desired-state";
import { DynamicUserServiceManager } from "../platform/dynamic-service-manager";
import { installProductionArtifacts } from "../platform/install";
import { getDesktopRemotePaths, type Platform } from "../platform/paths";
import { runCommand } from "../platform/command-runner";
import { readRuntimeMetadata } from "../platform/runtime-install";
import { ServiceController } from "../platform/service-controller";
import { SessionStore } from "../session/store";
import type { TuiSessionSource } from "../client/session-source";
import { runPipeMode } from "./run-pipe";
import type { CliDependencies } from "./main";

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
      try {
        const metadata = await readRuntimeMetadata(paths.runtimeMetadataPath);
        await runDaemon({ command: metadata.nodePath, args: [metadata.desktopCommanderEntry, "remote", "--persist-session"] });
      } catch (error) {
        if (!isEnoent(error)) throw error;
        await runDaemon({});
      }
    },
    writeOut: (text) => process.stdout.write(`${text}\n`),
    writeErr: (text) => process.stderr.write(`desktop-remote: ${text}\n`),
  };
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

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
