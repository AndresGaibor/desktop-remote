import { afterEach, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonIpcServer, type IpcDaemonSource } from "../../src/daemon/ipc-server";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { encodeFrame, parseServerMessage, PROTOCOL_VERSION } from "../../src/ipc/protocol";
import type { DesktopRemotePaths } from "../../src/platform/paths";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function paths(): Promise<DesktopRemotePaths> {
  const base = await mkdtemp(join(tmpdir(), "dr-deadline-")); dirs.push(base);
  return { appSupportDir: join(base,"app"), cacheDir: join(base,"cache"), binDir: join(base,"bin"), runtimeDir: join(base,"runtime"), logsDir: join(base,"logs"), socketPath: join(base,"daemon.sock"), desiredStatePath: join(base,"state"), historyPath: join(base,"history"), runtimeMetadataPath: join(base,"meta"), tunnelProfilePath: join(base,"tunnel.yaml") };
}

describe("daemon IPC operation deadlines", () => {
  test("passes deadline and abort signal to the daemon operation and returns a bounded error", async () => {
    const p = await paths();
    let sawAbort = false;
    let sawDeadline: number | undefined;
    const source: IpcDaemonSource = {
      snapshot: () => ({ connection: "online", rows: [], counts: { total:0,running:0,completed:0,failed:0 } }),
      status: () => ({ state:"online", restartCount:0, consecutiveFailures:0, startedAt:Date.now(), retainedCalls:0 }),
      onEvent: () => () => {}, stop: async () => {},
      execute: async (_name, _input, options) => {
        sawDeadline = options?.deadlineAt;
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) { sawAbort = true; return resolve(); }
          options?.signal?.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
        });
        throw new Error("cancelled by deadline");
      },
    };
    const server = new DaemonIpcServer({ source, paths: p }); await server.start();
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const socket = createConnection(p.socketPath); const decoder = new JsonLineDecoder();
        socket.once("connect", () => socket.write(encodeFrame({ type:"operation.request", protocolVersion:PROTOCOL_VERSION, requestId:"r1", name:"x", input:{}, deadlineAt: Date.now()+50 })));
        socket.on("data", (chunk) => { for (const value of decoder.push(chunk)) { const message=parseServerMessage(value); if(message.type==="operation.response"){socket.destroy();resolve(message);} } });
        socket.once("error", reject);
      });
      expect(sawDeadline).toBeNumber();
      expect(sawAbort).toBe(true);
      expect(response.error).toMatch(/deadline|timed out|cancelled/i);
    } finally { await server.stop(); }
  });
});
