import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { DaemonIpcServer, type IpcDaemonSource } from "../../src/daemon/ipc-server";
import { encodeFrame, parseClientMessage, parseServerMessage, PROTOCOL_VERSION, type ServerMessage } from "../../src/ipc/protocol";
import type { DesktopRemotePaths } from "../../src/platform/paths";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempPaths(): Promise<DesktopRemotePaths> {
  const base = await mkdtemp(join(tmpdir(), "daemon-ipc-"));
  directories.push(base);
  return {
    appSupportDir: join(base, "app"),
    cacheDir: join(base, "cache"),
    binDir: join(base, "bin"),
    runtimeDir: join(base, "runtime"),
    logsDir: join(base, "logs"),
    socketPath: join(base, "daemon.sock"),
    desiredStatePath: join(base, "state"),
    historyPath: join(base, "history.json"),
    runtimeMetadataPath: join(base, "meta.json"),
    tunnelProfilePath: join(base, "tunnel.yaml"),
  };
}

function sendRawOperation(socketPath: string, name: string, input: Record<string, unknown>, traceId: string): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    socket.once("connect", () => {
      socket.write(encodeFrame({
        type: "operation.request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "raw-1",
        name,
        input,
        traceId,
      }));
    });
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) {
        const message = parseServerMessage(value);
        if (message.type === "operation.response") {
          socket.destroy();
          resolve(message);
          return;
        }
      }
    });
    socket.once("error", reject);
  });
}

describe("traceId a traves del IPC daemon", () => {
  test("el DaemonIpcServer recibe y ecoa el traceId de la operacion", async () => {
    const paths = await tempPaths();
    const received: Array<string | undefined> = [];
    const receivedCallIds: Array<string | undefined> = [];
    const source: IpcDaemonSource = {
      snapshot: () => ({ connection: "online", rows: [], counts: { total: 0, running: 0, completed: 0, failed: 0 } }),
      status: () => ({ state: "online", restartCount: 0, consecutiveFailures: 0, startedAt: Date.now(), retainedCalls: 0 }),
      onEvent: () => () => {},
      stop: async () => {},
      execute: async (_name, _input, options) => {
        received.push(options?.traceId);
        receivedCallIds.push(options?.callId);
        return { ok: true };
      },
    };
    const server = new DaemonIpcServer({ source, paths });
    await server.start();
    try {
      const response = await sendRawOperation(paths.socketPath, "get_config", {}, "trace-xyz");
      // El traceId y requestId llegan al handler de operacion del daemon...
      expect(received).toContain("trace-xyz");
      expect(receivedCallIds).toContain("raw-1");
      // ...y el daemon ecoa el traceId en el frame de respuesta.
      expect(response.type).toBe("operation.response");
      if (response.type === "operation.response") {
        expect(response.traceId).toBe("trace-xyz");
      }
    } finally {
      await server.stop();
    }
  });

  test("el protocolo acepta traceId opcional sin romper el parseo", () => {
    const request = parseClientMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "operation.request",
      requestId: "r1",
      name: "get_config",
      input: {},
      traceId: "t1",
    });
    expect(request.type).toBe("operation.request");
    const response = parseServerMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "operation.response",
      requestId: "r1",
      result: { ok: true },
      traceId: "t1",
    });
    expect(response.type).toBe("operation.response");
  });
});
