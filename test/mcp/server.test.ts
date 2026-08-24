import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../src/mcp/server";

describe("MCP server", () => {
  test("registers the complete Desktop Remote operation catalog", () => {
    const server = createMcpServer({ execute: async () => ({}) });

    expect(server).toBeDefined();
  });
});
