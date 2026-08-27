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

function makeStatusResponse(requestId: string, extraFields?: Record<string, unknown>) {
  return {
    type: "status" as const,
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: {
      state: "online" as const,
      childPid: 123,
      restartCount: 0,
      consecutiveFailures: 0,
      startedAt: Date.now(),
      retainedCalls: 0,
      ...extraFields,
    },
  } as any;
}

describe("OperationIpcClient preflight validation", () => {
  test("sends a status request before first operation to validate contract", async () => {
    const socketPath = await tempSocket();
    const receivedRequests: string[] = [];
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          receivedRequests.push(message.type);
          if (message.type === "status.request") {
            socket.write(encodeFrame(makeStatusResponse(message.requestId)));
          }
          if (message.type === "operation.request") {
            socket.write(encodeFrame({
              type: "operation.response",
              protocolVersion: PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { ok: true },
            }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await client.execute("get_config", {});
      expect(receivedRequests[0]).toBe("status.request");
      expect(receivedRequests[1]).toBe("operation.request");
    } finally {
      server.close();
    }
  });

  test("throws RUNTIME_VERSION_MISMATCH when daemon returns different operationContractHash", async () => {
    const socketPath = await tempSocket();
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          if (message.type === "status.request") {
            socket.write(encodeFrame(makeStatusResponse(message.requestId, {
              buildId: "daemon-build",
              operationContractHash: "different-daemon-hash",
              protocolVersion: PROTOCOL_VERSION,
            })));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await expect(client.execute("get_config", {})).rejects.toThrow("RUNTIME_VERSION_MISMATCH");
    } finally {
      server.close();
    }
  });

  test("does not send operation.request when contract mismatch is detected", async () => {
    const socketPath = await tempSocket();
    const receivedRequests: string[] = [];
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          receivedRequests.push(message.type);
          if (message.type === "status.request") {
            socket.write(encodeFrame(makeStatusResponse(message.requestId, {
              buildId: "daemon-build",
              operationContractHash: "different-daemon-hash",
              protocolVersion: PROTOCOL_VERSION,
            })));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await expect(client.execute("get_config", {})).rejects.toThrow("RUNTIME_VERSION_MISMATCH");
      expect(receivedRequests).not.toContain("operation.request");
    } finally {
      server.close();
    }
  });

  test("subsequent operations use cached validation and do not re-request status", async () => {
    const socketPath = await tempSocket();
    const receivedRequests: string[] = [];
    const server: Server = createServer((socket: Socket) => {
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          receivedRequests.push(message.type);
          if (message.type === "status.request") {
            socket.write(encodeFrame(makeStatusResponse(message.requestId)));
          }
          if (message.type === "operation.request") {
            socket.write(encodeFrame({
              type: "operation.response",
              protocolVersion: PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { ok: true },
            }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new OperationIpcClient(socketPath);
      await client.execute("get_config", {});
      await client.execute("get_config", {});
      const statusCount = receivedRequests.filter((r) => r === "status.request").length;
      expect(statusCount).toBe(1);
    } finally {
      server.close();
    }
  });
});
