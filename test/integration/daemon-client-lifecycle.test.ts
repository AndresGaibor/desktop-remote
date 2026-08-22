import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRemoteIpcClient } from "../../src/client/ipc-client";
import { IpcTuiSessionSource } from "../../src/client/session-source";
import { DesktopRemoteDaemon } from "../../src/daemon/daemon";
import { DaemonIpcServer } from "../../src/daemon/ipc-server";
import { DaemonSupervisor, type ManagedRuntime } from "../../src/daemon/supervisor";
import type { RuntimeEvent } from "../../src/runtime/events";
import { SessionStore } from "../../src/session/store";

test("disposing and reattaching a TUI never restarts the daemon runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-remote-e2e-"));
  const socketPath = join(dir, "daemon.sock");
  const runtime = new FakeRuntime(4242);
  const supervisor = new DaemonSupervisor({ createRuntime: () => runtime });
  const daemon = new DesktopRemoteDaemon({ supervisor });
  const server = new DaemonIpcServer({
    source: daemon,
    paths: { appSupportDir: dir, cacheDir: dir, socketPath },
  });

  daemon.start();
  await server.start();
  try {
    const firstStore = new SessionStore();
    const first = createSource(firstStore, socketPath);
    await first.start(() => {});
    runtime.emit({
      type: "tool.started",
      callId: "one",
      toolName: "read_file",
      args: { path: "/one" },
      metadata: {},
      startedAt: 1,
    });
    await Bun.sleep(5);
    expect(firstStore.snapshot().rows.map((row) => row.callId)).toEqual(["one"]);
    expect(daemon.status()).toMatchObject({ childPid: 4242, restartCount: 0 });

    await first.stop();
    expect(runtime.running).toBe(true);
    expect(runtime.stops).toBe(0);

    const secondStore = new SessionStore();
    const second = createSource(secondStore, socketPath);
    await second.start(() => {});
    expect(secondStore.snapshot().rows.map((row) => row.callId)).toEqual(["one"]);
    expect(daemon.status()).toMatchObject({ childPid: 4242, restartCount: 0 });
    await second.stop();
  } finally {
    await server.stop();
    await daemon.stop();
  }
});

function createSource(store: SessionStore, socketPath: string) {
  return new IpcTuiSessionSource({
    store,
    createClient: () => new DesktopRemoteIpcClient({ socketPath }),
  });
}

class FakeRuntime implements ManagedRuntime {
  running = false;
  stops = 0;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(readonly pid: number) {}

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
