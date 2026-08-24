import { describe, expect, test } from "bun:test";
import { createToolDefinitions } from "../../src/mcp/tools";

describe("MCP tool definitions", () => {
  test("maps operation metadata into MCP tool annotations", () => {
    const definitions = createToolDefinitions();

    expect(definitions).toHaveLength(24);
    expect(definitions.find((tool) => tool.name === "read_file")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(definitions.find((tool) => tool.name === "write_file")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  });
});
