import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, parseServerMessage } from "../../src/ipc/protocol";
import { computeMcpToolCatalogHash, createToolDefinitions } from "../../src/mcp/tools";

describe("IPC protocol status contract fields", () => {
  test("status message includes runtime contract identity fields", () => {
    const identity = {
      buildId: "mcp-a",
      operationContractHash: computeMcpToolCatalogHash(createToolDefinitions()),
      protocolVersion: PROTOCOL_VERSION,
    };
    const message = parseServerMessage({
      type: "status",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "req-1",
      status: {
        state: "online",
        childPid: 123,
        restartCount: 0,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        retainedCalls: 0,
        ...identity,
      },
    });
    expect(message).toMatchObject({
      type: "status",
      status: expect.objectContaining({
        buildId: "mcp-a",
        operationContractHash: expect.any(String),
        protocolVersion: PROTOCOL_VERSION,
      }),
    });
  });

  test("status message without contract fields is still valid", () => {
    const message = parseServerMessage({
      type: "status",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "req-1",
      status: {
        state: "online",
        childPid: 123,
        restartCount: 0,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        retainedCalls: 0,
      },
    });
    expect(message).toMatchObject({ type: "status" });
  });
});
