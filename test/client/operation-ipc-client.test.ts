import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationIpcClient } from "../../src/client/operation-ipc-client";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { encodeFrame, parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from "../../src/ipc/protocol";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OperationIpcClient", () => {
  test("executes an operation through a framed Unix socket request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-op-"));
    const socketPath = join(dir, "daemon.sock");
    const server = createServer((socket) => {
      sockets.push(socket);
      const decoder = new JsonLineDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(chunk)) {
          const message = parseClientMessage(value);
          if (message.type !== "operation.request") continue;
          socket.write(encodeFrame({
            type: "operation.response",
            protocolVersion: PROTOCOL_VERSION,
            requestId: message.requestId,
            result: { name: message.name, input: message.input },
          }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    servers.push(server);

    await expect(new OperationIpcClient(socketPath).execute("read_file", { path: "/tmp/example" }))
      .resolves.toEqual({ name: "read_file", input: { path: "/tmp/example" } });
  });
});
