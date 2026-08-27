import { describe, expect, test } from "bun:test";
import { toolSchemas } from "../../src/mcp/schemas";

describe("MCP public contract fields", () => {
  test("advertises the implemented edit_block modes and safeguards", () => {
    expect(Object.keys(toolSchemas.edit_block.shape)).toContain("range");
    expect(Object.keys(toolSchemas.edit_block.shape)).toContain("content");
    expect(Object.keys(toolSchemas.edit_block.shape)).toContain("expected_replacements");
    expect(Object.keys(toolSchemas.edit_block.shape)).toContain("expected_sha256");

    expect(Object.keys(toolSchemas.start_search.shape)).toContain("contextLines");
    expect(Object.keys(toolSchemas.start_search.shape)).toContain("timeout_ms");
    expect(Object.keys(toolSchemas.start_search.shape)).toContain("earlyTermination");
  });

  test("does not advertise unrelated unimplemented fields", () => {
    expect(Object.keys(toolSchemas.edit_block.shape)).not.toContain("options");

    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("sheet");
    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("range");
    expect(Object.keys(toolSchemas.read_file.shape)).not.toContain("options");

    expect(Object.keys(toolSchemas.start_process.shape)).not.toContain("verbose_timing");
    expect(Object.keys(toolSchemas.read_process_output.shape)).not.toContain("verbose_timing");
    expect(Object.keys(toolSchemas.interact_with_process.shape)).not.toContain("verbose_timing");
  });
});
