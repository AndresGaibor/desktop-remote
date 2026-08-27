import { describe, expect, test } from "bun:test";
import { createToolDefinitions } from "../../src/mcp/tools";

describe("MCP tool definitions", () => {
  test("maps operation metadata into MCP tool annotations", () => {
    const definitions = createToolDefinitions("darwin");

    expect(definitions).toHaveLength(37);
    expect(definitions.find((tool) => tool.name === "read_file")).toMatchObject({
      title: "Read file",
      description: expect.stringContaining("Use this when"),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    });
    expect(definitions.find((tool) => tool.name === "write_file")).toMatchObject({
      title: "Write file",
      description: expect.stringContaining("Use this when"),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    });
    expect(definitions.find((tool) => tool.name === "start_process")).toMatchObject({
      title: "Start process",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    });
    expect(definitions.find((tool) => tool.name === "get_config")?.outputSchema).toBeDefined();
    expect(definitions.find((tool) => tool.name === "stop_search")?.outputSchema).toBeUndefined();
    expect(definitions.find((tool) => tool.name === "set_clipboard")).toMatchObject({
      title: "Set clipboard",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    });
  });

  test("structured-returning tools declare output schemas", () => {
    const definitions = createToolDefinitions("darwin");
    for (const tool of definitions) {
      if (tool.name === "stop_search") {
        expect(tool.outputSchema).toBeUndefined();
      } else {
        expect(tool.outputSchema, `${tool.name} output schema`).toBeDefined();
      }
    }
  });
});
