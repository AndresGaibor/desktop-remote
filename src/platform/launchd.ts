import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopRemotePaths } from "./paths";
import { requireSuccess, type CommandRunner } from "./command-runner";

export const LAUNCHD_LABEL = "com.desktop-remote.daemon";

export interface LaunchdClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const RealClock: LaunchdClock = {
  now: () => Date.now(),
  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export interface LaunchdManagerOptions {
  paths: DesktopRemotePaths;
  run: CommandRunner;
  uid: number;
  daemonCommand: string;
  daemonArgs?: string[];
  clock?: LaunchdClock;
}

export class LaunchdManager {
  private readonly _clock: LaunchdClock;

  constructor(private readonly options: LaunchdManagerOptions) {
    this._clock = options.clock ?? RealClock;
  }

  async install(): Promise<void> {
    const path = this.requirePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, launchAgentPlist(this.options.daemonCommand, this.options.daemonArgs ?? ["daemon"]), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async start(): Promise<void> {
    const domain = this.domain();
    const service = `${domain}/${LAUNCHD_LABEL}`;
    const bootout = await this.options.run("launchctl", ["bootout", service]);
    if (bootout.exitCode !== 0 && !isMissingService(bootout.stdout, bootout.stderr)) requireSuccess(bootout, "launchctl bootout");
    if (!isMissingService(bootout.stdout, bootout.stderr)) {
      await this.waitForUnloaded(service);
    }
    requireSuccess(await this.options.run("launchctl", ["bootstrap", domain, this.requirePath()]), "launchctl bootstrap");
    requireSuccess(await this.options.run("launchctl", ["enable", service]), "launchctl enable");
    requireSuccess(await this.options.run("launchctl", ["kickstart", "-k", service]), "launchctl kickstart");
  }

  private async waitForUnloaded(service: string): Promise<void> {
    const timeoutMs = 10_000;
    const intervalMs = 250;
    const deadline = this._clock.now() + timeoutMs;
    while (this._clock.now() < deadline) {
      const printResult = await this.options.run("launchctl", ["print", service]);
      if (printResult.exitCode !== 0 && isMissingService(printResult.stdout, printResult.stderr)) return;
      if (this._clock.now() >= deadline) break;
      await this._clock.sleep(intervalMs);
    }
  }

  async restart(): Promise<void> {
    requireSuccess(await this.options.run("launchctl", ["kickstart", "-k", `${this.domain()}/${LAUNCHD_LABEL}`]), "launchctl restart");
  }

  async status(): Promise<{ loaded: boolean; enabled: boolean; pid?: number; lastExitCode?: number }> {
    const result = await this.options.run("launchctl", ["print", `${this.domain()}/${LAUNCHD_LABEL}`]);
    if (result.exitCode !== 0) return { loaded: false, enabled: false };
    const pid = matchInt(result.stdout, /\bpid\s*=\s*(\d+)/);
    const lastExitCode = matchInt(result.stdout, /last exit code\s*=\s*(-?\d+)/i);
    return { loaded: true, enabled: true, pid, lastExitCode };
  }

  async stop(): Promise<void> {
    const service = `${this.domain()}/${LAUNCHD_LABEL}`;
    requireSuccess(await this.options.run("launchctl", ["disable", service]), "launchctl disable");
    const result = await this.options.run("launchctl", ["bootout", service]);
    if (result.exitCode !== 0 && !isMissingService(result.stdout, result.stderr)) requireSuccess(result, "launchctl bootout");
  }

  private domain(): string { return `gui/${this.options.uid}`; }
  private requirePath(): string {
    if (!this.options.paths.launchAgentPath) throw new Error("LaunchAgent path is unavailable on this platform");
    return this.options.paths.launchAgentPath;
  }
}

function isMissingService(stdout: string, stderr: string): boolean {
  return /not found|could not find|no such process|not loaded/i.test(`${stdout}\n${stderr}`);
}

export function launchAgentPlist(command: string, args: string[] = ["daemon"]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(command ? LAUNCHD_LABEL : LAUNCHD_LABEL)}</string>\n<key>ProgramArguments</key><array><string>${xml(command)}</string>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function matchInt(text: string, pattern: RegExp): number | undefined {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
