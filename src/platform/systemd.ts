import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopRemotePaths } from "./paths";
import { requireSuccess, type CommandRunner } from "./command-runner";

export const SYSTEMD_UNIT = "desktop-remote.service";

export interface SystemdUserManagerOptions {
  paths: DesktopRemotePaths;
  run: CommandRunner;
  daemonCommand: string;
  daemonArgs?: string[];
}

export class SystemdUserManager {
  constructor(private readonly options: SystemdUserManagerOptions) {}

  async install(): Promise<void> {
    const path = this.requirePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, systemdUnit(this.options.daemonCommand, this.options.daemonArgs ?? ["daemon"]), { mode: 0o600 });
    await chmod(path, 0o600);
    requireSuccess(await this.options.run("systemctl", ["--user", "daemon-reload"]), "systemd daemon-reload");
  }

  async start(): Promise<void> {
    requireSuccess(await this.options.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]), "systemd start");
  }
  async restart(): Promise<void> {
    requireSuccess(await this.options.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]), "systemd restart");
  }
  async status(): Promise<{ active: boolean; enabled: boolean; pid?: number }> {
    const active = await this.options.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    const enabled = await this.options.run("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]);
    const pidResult = await this.options.run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=MainPID", "--value"]);
    const pid = Number.parseInt(pidResult.stdout.trim(), 10);
    return { active: active.exitCode === 0 && active.stdout.trim() === "active", enabled: enabled.exitCode === 0, pid: Number.isFinite(pid) && pid > 0 ? pid : undefined };
  }

  async stop(): Promise<void> {
    requireSuccess(await this.options.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]), "systemd stop");
  }

  private requirePath(): string {
    if (!this.options.paths.systemdUserUnitPath) throw new Error("systemd user unit path is unavailable on this platform");
    return this.options.paths.systemdUserUnitPath;
  }
}

export function systemdUnit(command: string, args: string[] = ["daemon"]): string {
  return `[Unit]\nDescription=Desktop Remote daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${[command, ...args].map(systemdEscape).join(" ")}\nRestart=on-failure\nRestartSec=10\nKillSignal=SIGTERM\n\n[Install]\nWantedBy=default.target\n`;
}

function systemdEscape(value: string): string {
  if (/\s/.test(value)) throw new Error("systemd daemon command path may not contain whitespace");
  return value.replaceAll("%", "%%");
}
