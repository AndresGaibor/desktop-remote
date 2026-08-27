import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { OperationIpcClient } from "../../src/client/operation-ipc-client";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { encodeFrame, parseClientMessage, PROTOCOL_VERSION } from "../../src/ipc/protocol";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempSocket(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "op-ipc-"));
  directories.push(directory);
  return join(directory, "daemon.sock");
}

describe("OperationIpcClient deadlines", () => {
  test("rejects after timeout when the daemon never responds and destroys only its socket", async () => {
    const socketPath = await tempSocket();
    let serverSocket: Socket | undefined;
    const server: Server = createServer((socket: Socket) => {
      serverSocket = socket;
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      const start = Date.now();
      await expect(client.execute("get_config", {}, { timeoutMs: 200 }))
        .rejects.toThrow(/timed out after 200ms/);
      expect(Date.now() - start).toBeLessThan(2000);
      // El socket del cliente debe cerrarse: el servidor detecta el cierre de su extremo.
      await new Promise<void>((resolve) => {
        if (serverSocket?.destroyed) return resolve();
        serverSocket?.once("close", resolve);
        setTimeout(resolve, 1000);
      });
      expect(serverSocket?.destroyed).toBe(true);
    } finally {
      server.close();
    }
  });

  test("a subsequent operation opens a fresh socket and succeeds", async () => {
    const socketPath = await tempSocket();
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          if (message.type === "operation.request") {
            // Responde tras 200ms: el primer call (timeout 50ms) expira y destruye su socket;
            // el segundo call (timeout 2000ms) usa un socket nuevo y recibe la respuesta.
            setTimeout(() => {
              if (socket.destroyed) return;
              socket.write(encodeFrame({
                type: "operation.response",
                protocolVersion: PROTOCOL_VERSION,
                requestId: message.requestId,
                result: { ok: true },
              }));
            }, 200);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await expect(client.execute("get_config", {}, { timeoutMs: 50 }))
        .rejects.toThrow(/timed out/);
      await expect(client.execute("get_config", {}, { timeoutMs: 2000 }))
        .resolves.toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  test("honors AbortSignal", async () => {
    const socketPath = await tempSocket();
    const server: Server = createServer(() => {
      // no responde
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      const controller = new AbortController();
      const pending = client.execute("get_config", {}, { timeoutMs: 5000, signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/);
    } finally {
      server.close();
    }
  });

  test("propagates traceId to the request and echoes it back", async () => {
    const socketPath = await tempSocket();
    const received: Array<{ traceId?: string; requestId: string }> = [];
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          if (message.type === "operation.request") {
            received.push({ traceId: message.traceId, requestId: message.requestId });
            socket.write(encodeFrame({
              type: "operation.response",
              protocolVersion: PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { ok: true },
              ...(message.traceId !== undefined ? { traceId: message.traceId } : {}),
            }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await client.execute("get_config", {}, { timeoutMs: 2000, traceId: "trace-abc" });
      // El cliente envia el traceId en el frame de request (lo verifica el servidor).
      expect(received[0]?.traceId).toBe("trace-abc");
    } finally {
      server.close();
    }
  });
});

test("OperationIpcClient propagates an absolute deadlineAt derived from timeoutMs", async () => {
  const socketPath = await tempSocket();
  let deadlineAt: number | undefined;
  const before = Date.now();
  const server: Server = createServer((socket: Socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) {
        const message = parseClientMessage(value);
        if (message.type !== "operation.request") continue;
        deadlineAt = message.deadlineAt;
        socket.write(encodeFrame({ type: "operation.response", protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, result: { ok: true } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await new OperationIpcClient(socketPath).execute("get_config", {}, { timeoutMs: 750 });
    expect(deadlineAt).toBeNumber();
    expect(deadlineAt!).toBeGreaterThanOrEqual(before + 700);
    expect(deadlineAt!).toBeLessThanOrEqual(Date.now() + 800);
  } finally { server.close(); }
});
