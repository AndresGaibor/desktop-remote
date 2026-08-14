import { expect, test } from "bun:test";
import { buildToolDetailPresentation } from "../../src/tui/tool-detail";
import type { ToolCallRow } from "../../src/session/types";

function row(
  toolName: string,
  args: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    callId: "call-1",
    toolName,
    args,
    metadata: {},
    status: "running",
    startedAt: 1,
    ...overrides,
  };
}

test("parses write_file arguments into readable content", () => {
  const presentation = buildToolDetailPresentation(row("write_file", {
    path: "/project/src/app.ts",
    mode: "append",
    content: "export const one = 1;\nexport const two = 2;\n",
  }));

  expect(presentation.kind).toBe("write");
  expect(presentation.path).toBe("/project/src/app.ts");
  expect(presentation.mode).toBe("append");
  expect(presentation.content).toBe("export const one = 1;\nexport const two = 2;\n");
  expect(presentation.filetype).toBe("typescript");
});

test("parses edit_block arguments into a readable diff", () => {
  const presentation = buildToolDetailPresentation(row("edit_block", {
    file_path: "/project/src/app.ts",
    old_string: "const oldValue = true;",
    new_string: "const newValue = true;",
    expected_replacements: 1,
  }));

  expect(presentation.kind).toBe("edit");
  expect(presentation.path).toBe("/project/src/app.ts");
  expect(presentation.diffLines).toEqual([
    "- const oldValue = true;",
    "+ const newValue = true;",
  ]);
});

test("parses start_process shell command and timeout", () => {
  const presentation = buildToolDetailPresentation(row("start_process", {
    shell: "/bin/bash",
    command: "bun test && bun run typecheck",
    timeout_ms: 20000,
  }));

  expect(presentation.kind).toBe("process");
  expect(presentation.fields).toEqual([
    { label: "Shell", value: "/bin/bash" },
    { label: "Timeout", value: "20s" },
  ]);
  expect(presentation.content).toBe("bun test && bun run typecheck");
});

test("parses read_file source, range, and wrapped content", () => {
  const presentation = buildToolDetailPresentation(row("read_file", {
    path: "/project/src/app.ts",
    isUrl: false,
    offset: 0,
    length: 24,
  }, {
    resultText: "[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\nexport const app = true;\nexport default app;\n\n[executed on device: mac.local]",
    status: "completed",
  }));

  expect(presentation.kind).toBe("read");
  expect(presentation.path).toBe("/project/src/app.ts");
  expect(presentation.fields).toEqual([
    { label: "Source", value: "Local file" },
    { label: "Range", value: "lines 1–24" },
  ]);
  expect(presentation.content).toBe("export const app = true;\nexport default app;");
  expect(presentation.filetype).toBe("typescript");
});