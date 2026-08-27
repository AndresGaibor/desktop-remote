import type { DaemonStatus } from "../daemon/daemon";
import type { DesiredState } from "../platform/desired-state";
import type { ServiceManagerStatus } from "../platform/service-controller";

export interface CliService {
  install(): Promise<void>;
  start(): Promise<DaemonStatus>;
  stop(): Promise<void>;
  restart(): Promise<DaemonStatus>;
  ensureRunning(): Promise<DaemonStatus>;
  status(): Promise<DaemonStatus | ServiceManagerStatus>;
}

export interface CliDependencies {
  stdinIsTTY: boolean;
  readDesiredState(): Promise<DesiredState>;
  service: CliService;
  attach(): Promise<void>;
  replay(file: string): Promise<void>;
  pipe(): Promise<void>;
  logs(follow: boolean): Promise<void>;
  daemon(args: string[]): Promise<void>;
  mcpServe(): Promise<void>;
  tunnelInit(args: string[]): Promise<void>;
  tunnelDoctor(): Promise<void>;
  tunnelStatus(): Promise<void>;
  doctor(format: "json" | "text"): Promise<void>;
  update?(): Promise<void>;
  updateLocal?(): Promise<void>;
  rollback(): Promise<void>;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

const ADMIN = new Set(["install", "start", "stop", "restart", "status", "logs", "attach", "replay", "daemon", "mcp", "tunnel", "doctor", "update", "update-local", "rollback"]);

export async function runCli(argv: string[], deps: CliDependencies): Promise<number> {
  const command = argv[0];
  try {
    if (command === "--help" || command === "-h" || command === "help") { deps.writeOut(HELP_TEXT); return 0; }
    if (command === "--version" || command === "-V") { deps.writeOut("1.0.0"); return 0; }
    if (!command) {
      if (!deps.stdinIsTTY) { await deps.pipe(); return 0; }
      if (await deps.readDesiredState() === "stopped") {
        deps.writeErr("Desktop Remote is intentionally stopped. Run: desktop-remote start");
        return 1;
      }
      await deps.service.ensureRunning();
      await deps.attach();
      return 0;
    }

    if (!ADMIN.has(command)) throw new Error(`Unknown command: ${command}`);
    switch (command) {
      case "install": await deps.service.install(); deps.writeOut("Desktop Remote installed"); return 0;
      case "start": await deps.service.start(); deps.writeOut("Desktop Remote started"); return 0;
      case "stop": await deps.service.stop(); deps.writeOut("Desktop Remote stopped"); return 0;
      case "restart": await deps.service.restart(); deps.writeOut("Desktop Remote restarted"); return 0;
      case "status": deps.writeOut(JSON.stringify(await deps.service.status(), null, 2)); return 0;
      case "logs": await deps.logs(argv.includes("--follow")); return 0;
      case "attach": await deps.attach(); return 0;
      case "replay": {
        const file = argv[1]; if (!file) throw new Error("replay requires a file");
        await deps.replay(file); return 0;
      }
      case "daemon": await deps.daemon(argv.slice(1)); return 0;
      case "mcp": await deps.mcpServe(); return 0;
      case "tunnel": {
        const subcommand = argv[1];
        if (subcommand === "init") {
          rejectLiteralSecret(argv.slice(2).join(" "));
          requireOption(argv.slice(2), "--tunnel-id");
          requireOption(argv.slice(2), "--profile");
          await deps.tunnelInit(argv.slice(2));
          return 0;
        }
        if (subcommand === "doctor") { await deps.tunnelDoctor(); return 0; }
        if (subcommand === "status") { await deps.tunnelStatus(); return 0; }
        throw new Error("tunnel requires init, doctor, or status");
      }
      case "doctor": {
        await deps.doctor(argv.includes("--json") ? "json" : "text");
        return 0;
      }
      case "update":
      case "update-local": {
        const update = command === "update-local" ? deps.updateLocal ?? deps.update : deps.update ?? deps.updateLocal;
        if (!update) throw new Error("update-local is unavailable");
        await update();
        return 0;
      }
      case "rollback": {
        await deps.rollback();
        return 0;
      }
    }
    return 1;
  } catch (error) {
    deps.writeErr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const HELP_TEXT = `Usage: desktop-remote [command]

Commands:
  start      Start and enable the background daemon
  stop       Persistently stop and disable the daemon
  restart    Restart the daemon
  status     Show daemon/service status
  attach     Attach the optional TUI
  logs       Show bounded daemon logs (--follow to stream)
  install    Build and install the user service
  replay     Replay a JSONL diagnostic session
  mcp        Start the local MCP server over stdio
  tunnel init --tunnel-id ID --profile FILE  Save profile and generate an optional tunnel service
  tunnel doctor                           Validate the local tunnel profile
  tunnel status                           Probe local tunnel liveness and readiness
  doctor [--json]                         Run health diagnostics (--json for machine-readable output)
  update     Build and promote new binary transactionally (legacy alias)
  update-local Build/test checkout and promote it transactionally
  rollback   Restore previous runtime transactionally
`;

function requireOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`tunnel init requires ${name}`);
  return value;
}

function rejectLiteralSecret(value: string): void {
  if (/sk-[A-Za-z0-9_-]{8,}|(?:api[-_ ]?key|token)\s*[:=]/i.test(value)) {
    throw new Error("literal API key/secret is forbidden");
  }
}
