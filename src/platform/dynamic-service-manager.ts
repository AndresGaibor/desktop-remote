import { join } from "node:path";
import type { CommandRunner } from "./command-runner";
import { LaunchdManager } from "./launchd";
import type { DesktopRemotePaths, Platform } from "./paths";
import type { ServiceManagerStatus, UserServiceManager } from "./service-controller";
import { SystemdUserManager } from "./systemd";
import { readInstalledBuildLayout } from "./install";

export class DynamicUserServiceManager implements UserServiceManager {
  constructor(private readonly options: {
    paths: DesktopRemotePaths;
    run: CommandRunner;
    platform: Platform;
    uid?: number;
  }) {}

  async install(): Promise<void> { await (await this.impl()).install(); }
  async start(): Promise<void> { await (await this.impl()).start(); }
  async restart(): Promise<void> { await (await this.impl()).restart(); }
  async stop(): Promise<void> { await (await this.impl()).stop(); }
  async status(): Promise<ServiceManagerStatus> { return (await this.impl()).status(); }

  private async impl(): Promise<LaunchdManager | SystemdUserManager> {
    const layout = await readInstalledBuildLayout(this.options.paths);
    const command = join(this.options.paths.binDir, layout.daemon);
    if (this.options.platform === "darwin") {
      const uid = this.options.uid ?? process.getuid?.();
      if (uid === undefined) throw new Error("Unable to determine macOS user id");
      return new LaunchdManager({ paths: this.options.paths, run: this.options.run, uid, daemonCommand: command, daemonArgs: layout.daemonArgs });
    }
    if (this.options.platform === "linux") {
      return new SystemdUserManager({ paths: this.options.paths, run: this.options.run, daemonCommand: command, daemonArgs: layout.daemonArgs });
    }
    throw new Error(`Desktop Remote service installation is unsupported on ${this.options.platform}`);
  }
}
