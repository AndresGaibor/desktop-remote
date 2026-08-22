#!/usr/bin/env bun
import { Command } from "commander";
import { selectCliMode } from "../src/cli/mode";
import { runPipeMode } from "../src/cli/run-pipe";
import { readJsonlEvents } from "../src/logging/jsonl";
import { DesktopRemoteIpcClient } from "../src/client/ipc-client";
import { IpcTuiSessionSource, type TuiSessionSource } from "../src/client/session-source";
import { SessionStore } from "../src/session/store";
import { runDaemon } from "../src/daemon/run-daemon";

const program = new Command();

program
  .name("desktop-remote")
  .description("Interactive TUI and local supervisor for Desktop Commander Remote")
  .version("1.0.0")
  .option("-v, --verbose", "Show verbose lines in legacy pipe mode")
  .option("-f, --full", "Disable compaction in legacy pipe mode")
  .option("-m, --max-lines <number>", "Pipe-mode compaction limit", "15")
  .option("--cmd <command>", "Custom executable instead of desktop-commander")
  .option("--save-log <filepath>", "Save legacy formatted pipe output")
  .option("--log-jsonl <filepath>", "Write redacted structured session events")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options, commandObj) => {
    const mode = selectCliMode({
      stdinIsTTY: Boolean(process.stdin.isTTY),
      args: commandObj.args,
    });

    if (mode.kind === "pipe") {
      const maxLines = options.full ? 0 : parseMaxLines(options.maxLines);
      await runPipeMode({
        verbose: Boolean(options.verbose),
        maxLines,
        saveLogPath: options.saveLog,
      });
      return;
    }

    if (mode.kind === "replay") {
      const events = await readJsonlEvents(mode.file);
      const store = new SessionStore();
      for (const event of events) store.consume(event);
      const { runTui } = await import("../src/tui/run-tui");
      await runTui({ source: REPLAY_SOURCE, store });
      return;
    }

    if (mode.kind === "daemon") {
      await runDaemon({
        command: options.cmd,
        args: mode.desktopCommanderArgs,
      });
      return;
    }

    if (options.saveLog) {
      throw new Error("--save-log is for piped compatibility mode; use --log-jsonl with the TUI");
    }

    if (options.logJsonl) {
      throw new Error("--log-jsonl is not available in attached TUI mode; use daemon logging");
    }
    const store = new SessionStore();
    const source = new IpcTuiSessionSource({
      store,
      createClient: () => new DesktopRemoteIpcClient(),
    });
    const { runTui } = await import("../src/tui/run-tui");
    await runTui({ source, store });
  });

const REPLAY_SOURCE: TuiSessionSource = {
  start: async () => {},
  stop: async () => {},
  connectionState: () => "connected",
};

function parseMaxLines(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "15"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --max-lines value: ${String(value)}`);
  }
  return parsed;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`desktop-remote: ${message}`);
  process.exitCode = 1;
}
