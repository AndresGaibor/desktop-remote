import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyAttachedError, DesktopRemoteIpcClient } from "../../src/client/ipc-client";
import { attachTui } from "../../src/client/run-attach";
import { DaemonIpcServer, type IpcDaemonSource } from "../../src/daemon/ipc-server";
import { makeTestPaths } from "../helpers/desktop-remote-paths";
import type { RuntimeSessionSnapshot } from "../../src/session/types";

const servers: DaemonIpcServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function setupServer() {
  const dir = await mkdtemp(join(tmpdir(), "dr-attach-"));
  const paths = makeTestPaths(dir);
  const snapshot: RuntimeSessionSnapshot = {
    connection: "online",
    rows: [],
    counts: { total: 0, running: 0, completed: 0, failed: 0 },
  };
  const source: IpcDaemonSource = {
    snapshot: () => snapshot,
    status: () => ({ state: "online", childPid: 77, restartCount: 0, consecutiveFailures: 0, startedAt: 1, retainedCalls: 0 }),
    onEvent: () => () => {},
    stop: async () => {},
    execute: async () => undefined,
  };
  const server = new DaemonIpcServer({ source, paths });
  await server.start();
  servers.push(server);
  return paths;
}

describe("attachTui", () => {
  test("preflights the visual lease before invoking the renderer", async () => {
    const paths = await setupServer();
    let rendered = 0;
    const attached = await attachTui({
      socketPath: paths.socketPath,
      runTui: async ({ source }) => {
        rendered += 1;
        await source.start(() => {});
      },
      bunRuntime: true,
    });
    expect(rendered).toBe(1);
    expect(attached.source.connectionState()).toBe("connected");
    await attached.source.stop();
  });

  test("rejects a second visual attach before invoking its renderer", async () => {
    const paths = await setupServer();
    const firstClient = new DesktopRemoteIpcClient({ socketPath: paths.socketPath });
    await firstClient.connect("visual");
    let rendered = 0;
    await expect(attachTui({
      socketPath: paths.socketPath,
      runTui: async () => { rendered += 1; },
      bunRuntime: true,
    })).rejects.toBeInstanceOf(AlreadyAttachedError);
    expect(rendered).toBe(0);
    await firstClient.close();
  });

});
