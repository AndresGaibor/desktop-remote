import { createConnection, type Socket } from "node:net";
import { JsonLineDecoder } from "../ipc/framing";
import {
  encodeFrame,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../ipc/protocol";

export class OperationIpcClient {
  private requestCounter = 0;

  constructor(private readonly socketPath: string) {}

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    const requestId = `operation-${++this.requestCounter}`;
    const socket = createConnection(this.socketPath);
    const decoder = new JsonLineDecoder();
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const message = parseServerMessage(value);
            if (message.type !== "operation.response" || message.requestId !== requestId) continue;
            finish(() => {
              if (message.error !== undefined) reject(new Error(message.error));
              else resolve(message.result);
            });
          }
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once("connect", () => {
        try {
          socket.write(encodeFrame({
            type: "operation.request",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            name,
            input,
          }));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once("error", (error) => finish(() => reject(error)));
      socket.once("close", () => {
        if (!settled) finish(() => reject(new Error("Desktop Remote operation IPC connection closed")));
      });
    });
  }
}
