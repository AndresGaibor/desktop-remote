import { describe, expect, test } from "bun:test";
import { toolSchemas } from "../../src/mcp/schemas";

describe("MCP public contract fields", () => {
  test("does not advertise fields that the executor does not implement yet", () => {
    expect(Object.keys(toolSchemas.edit_block.shape)).not.toContain("range");
    expect(Object.keys(toolSchemas.edit_block.shape)).not.toContain("content");
    expect(Object.keys(toolSchemas.edit_block.shape)).not.toContain("expected_replacements");
    expect(Object.keys(toolSchemas.edit_block.shape)).not.toContain("options");

    expect(Object.keys(toolSchemas.start_search.shape)).not.toContain("contextLines");
    expect(Object.keys(toolSchemas.start_search.shape)).not.toContain("timeout_ms");
    expect(Object.keys(toolSchemas.start_search.shape)).not.toContain("earlyTermination");

    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("sheet");
    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("range");
    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("options");

    expect(Object.keys(toolSchemas.start_process.shape)).not.toContain("verbose_timing");
    expect(Object.keys(toolSchemas.read_process_output.shape)).not.toContain("verbose_timing");
    expect(Object.keys(toolSchemas.interact_with_process.shape)).not.toContain("verbose_timing");
  });
});
