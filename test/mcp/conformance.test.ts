import { describe, expect, test } from "bun:test";
import { createToolDefinitions } from "../../src/mcp/tools";
import { z } from "zod";

describe("MCP tool conformance", () => {
  const EXPECTED_COUNT = 24;

  test("registers exactly 24 tools", () => {
    const definitions = createToolDefinitions();
    const actualCount = definitions.length;

    expect(
      actualCount,
      `Expected exactly ${EXPECTED_COUNT} tools but found ${actualCount}. ` +
        `Tool names: [${definitions.map((t) => t.name).join(", ")}]`,
    ).toBe(EXPECTED_COUNT);
  });

  test("each tool has a non-empty name, description, and valid inputSchema", () => {
    const definitions = createToolDefinitions();

    for (const tool of definitions) {
      expect(tool.name, `Tool must have a non-empty name`).toBeTruthy();
      expect(typeof tool.name === "string" && tool.name.length > 0, `Tool name must be a non-empty string`).toBe(true);
      expect(tool.description, `Tool "${tool.name}" must have a non-empty description`).toBeTruthy();
      expect(
        typeof tool.description === "string" && tool.description.length > 0,
        `Tool "${tool.name}" description must be a non-empty string`,
      ).toBe(true);
      expect(tool.inputSchema, `Tool "${tool.name}" must have an inputSchema`).toBeDefined();
      expect(tool.inputSchema instanceof z.ZodType, `Tool "${tool.name}" inputSchema must be a ZodType`).toBe(true);
    }
  });

  test("no duplicate tool names", () => {
    const definitions = createToolDefinitions();
    const names = definitions.map((t) => t.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates, `Duplicate tool names found: [${duplicates.join(", ")}]`).toHaveLength(0);
  });
});
