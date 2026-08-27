import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/ipc/protocol";
import { computeMcpToolCatalogHash, createToolDefinitions } from "../../src/mcp/tools";
import {
  assertRuntimeContract,
  getRuntimeContractIdentity,
  type RuntimeContractIdentity,
} from "../../src/runtime/contract";

describe("RuntimeContractIdentity", () => {
  test("getRuntimeContractIdentity returns an object with all three fields", () => {
    const identity = getRuntimeContractIdentity();
    expect(identity).toHaveProperty("buildId");
    expect(identity).toHaveProperty("operationContractHash");
    expect(identity).toHaveProperty("protocolVersion");
    expect(typeof identity.buildId).toBe("string");
    expect(typeof identity.operationContractHash).toBe("string");
    expect(typeof identity.protocolVersion).toBe("number");
  });

  test("operationContractHash matches computeMcpToolCatalogHash(createToolDefinitions())", () => {
    const identity = getRuntimeContractIdentity();
    const expectedHash = computeMcpToolCatalogHash(createToolDefinitions());
    expect(identity.operationContractHash).toBe(expectedHash);
  });

  test("protocolVersion matches PROTOCOL_VERSION", () => {
    const identity = getRuntimeContractIdentity();
    expect(identity.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("identity is deterministic across calls", () => {
    const first = getRuntimeContractIdentity();
    const second = getRuntimeContractIdentity();
    expect(first).toEqual(second);
  });

  test("assertRuntimeContract throws when operationContractHash differs", () => {
    expect(() => assertRuntimeContract({
      buildId: "mcp-a",
      operationContractHash: "different-daemon-hash",
      protocolVersion: PROTOCOL_VERSION,
    })).toThrow("RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.");
  });

  test("assertRuntimeContract throws when buildId differs", () => {
    expect(() => assertRuntimeContract({
      buildId: "different-build",
      operationContractHash: computeMcpToolCatalogHash(createToolDefinitions()),
      protocolVersion: PROTOCOL_VERSION,
    })).toThrow("RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.");
  });

  test("assertRuntimeContract throws when protocolVersion differs", () => {
    expect(() => assertRuntimeContract({
      buildId: "mcp-a",
      operationContractHash: computeMcpToolCatalogHash(createToolDefinitions()),
      protocolVersion: PROTOCOL_VERSION + 1,
    })).toThrow("RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.");
  });

  test("assertRuntimeContract does not throw when all fields match", () => {
    const identity = getRuntimeContractIdentity();
    expect(() => assertRuntimeContract(identity)).not.toThrow();
  });
});
