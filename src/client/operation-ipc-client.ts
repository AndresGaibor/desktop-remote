import { createConnection, type Socket } from "node:net";
import { JsonLineDecoder } from "../ipc/framing";
import {
  encodeFrame,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../ipc/protocol";
import { assertRuntimeContract, type RuntimeContractIdentity } from "../runtime/contract";

export interface OperationExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  traceId?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class OperationIpcClient {
  private requestCounter = 0;
  private contractValidated = false;
  private pendingValidation: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | undefined;
  private validationSocket: Socket | undefined;
  private validationDecoder = new JsonLineDecoder();

  constructor(private readonly socketPath: string) {}

  async execute(
    name: string,
    input: Record<string, unknown>,
    options: OperationExecutionOptions = {},
  ): Promise<unknown> {
    if (!this.contractValidated) {
      await this.validateContract(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }
    return this.executeOperation(name, input, options);
  }

  private validateContract(timeoutMs: number): Promise<void> {
    if (this.contractValidated) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.validationSocket = socket;
      this.validationDecoder = new JsonLineDecoder();

      const fail = (error: unknown) => {
        this.cleanupValidation();
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new Error(`Desktop Remote contract validation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on("data", (chunk) => {
        try {
          for (const value of this.validationDecoder.push(chunk)) {
            const message = parseServerMessage(value) as ServerMessage;
            if (message.type !== "status" || !this.pendingValidation) continue;
            clearTimeout(timer);
            const status = message.status as unknown as Record<string, unknown>;
            const daemonIdentity: RuntimeContractIdentity = {
              buildId: status.buildId as string,
              operationContractHash: status.operationContractHash as string,
              protocolVersion: status.protocolVersion as number,
            };
            const pending = this.pendingValidation;
            try {
              assertRuntimeContract(daemonIdentity);
              this.contractValidated = true;
              this.cleanupValidation();
              pending?.resolve();
            } catch (error) {
              this.cleanupValidation();
              pending?.reject(error);
            }
          }
        } catch (error) {
          fail(error);
        }
      });

      socket.on("error", fail);
      socket.on("close", () => {
        if (this.pendingValidation) {
          fail(new Error("Desktop Remote contract validation IPC connection closed"));
        }
      });

      socket.once("connect", () => {
        try {
          const requestId = `status-${++this.requestCounter}`;
          this.pendingValidation = { resolve, reject };
          socket.write(encodeFrame({
            type: "status.request",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
          }));
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  private cleanupValidation(): void {
    if (this.validationSocket && !this.validationSocket.destroyed) {
      this.validationSocket.destroy();
    }
    this.validationSocket = undefined;
    this.pendingValidation = undefined;
  }

  private executeOperation(
    name: string,
    input: Record<string, unknown>,
    options: OperationExecutionOptions,
  ): Promise<unknown> {
    const requestId = `operation-${++this.requestCounter}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const socket = createConnection(this.socketPath);
    const decoder = new JsonLineDecoder();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (onAbort !== undefined) {
        options.signal?.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    return new Promise<unknown>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        callback();
      };
      const fail = (error: unknown) => finish(() => reject(error));
      const succeed = (value: unknown) => finish(() => resolve(value));

      timer = setTimeout(() => {
        fail(new Error(`Desktop Remote operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (options.signal) {
        if (options.signal.aborted) {
          fail(new Error("Desktop Remote operation was aborted"));
          return;
        }
        onAbort = () => fail(new Error("Desktop Remote operation was aborted"));
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const message = parseServerMessage(value) as ServerMessage;
            if (message.type !== "operation.response" || message.requestId !== requestId) continue;
            if (message.error !== undefined) fail(new Error(message.error));
            else succeed(message.result);
          }
        } catch (error) {
          fail(error);
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
            deadlineAt,
            ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
          }));
        } catch (error) {
          fail(error);
        }
      });

      socket.once("error", (error) => fail(error));
      socket.once("close", () => {
        if (!settled) fail(new Error("Desktop Remote operation IPC connection closed"));
      });
    });
  }
}
