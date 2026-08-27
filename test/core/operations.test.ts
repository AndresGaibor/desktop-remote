import { describe, expect, test } from "bun:test";
import { getOperation, listOperations } from "../../src/core/operations";

describe("operation registry", () => {
  test("exposes the supported portable tools and macOS controls on macOS", () => {
    expect(listOperations("darwin").map((operation) => operation.name)).toEqual([
      "read_file",
      "read_multiple_files",
      "write_file",
      "create_directory",
      "list_directory",
      "move_file",
      "get_file_info",
      "edit_block",
      "write_pdf",
      "start_search",
      "get_more_search_results",
      "stop_search",
      "list_searches",
      "start_process",
      "read_process_output",
      "interact_with_process",
      "force_terminate",
      "list_sessions",
      "list_processes",
      "kill_process",
      "get_config",
      "set_config_value",
      "get_usage_stats",
      "get_recent_tool_calls",
      "get_active_window",
      "list_windows",
      "open_app",
      "focus_window",
      "screenshot",
      "get_clipboard",
      "set_clipboard",
      "type_text",
      "key_press",
      "click",
      "double_click",
      "scroll",
      "drag",
    ]);
  });

  test("does not register macOS controls on non-macOS", () => {
    expect(listOperations("linux").some((operation) => operation.name === "click")).toBe(false);
  });

  test("marks destructive operations so MCP clients can present risk", () => {
    expect(getOperation("write_file")).toMatchObject({ destructive: true });
    expect(getOperation("read_file")).toMatchObject({ destructive: false });
  });

  test("returns undefined for unknown operations", () => {
    expect(getOperation("unknown")).toBeUndefined();
  });
});
