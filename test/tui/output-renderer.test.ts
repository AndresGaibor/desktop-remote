import { describe, expect, test } from "bun:test";
import {
  classifyDetailContent,
  classifyDiagnosticLine,
  inferFiletype,
} from "../../src/tui/output-renderer";
import type { ToolCallRow } from "../../src/session/types";

function row(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    callId: "call-1",
    toolName: "read_file",
    args: { path: "/project/src/app.ts" },
    metadata: {},
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    resultText: "const answer: number = 42;",
    ...overrides,
  };
}

describe("detail output classification", () => {
  test("infers OpenTUI parser filetypes from paths", () => {
    expect(inferFiletype("src/app.ts")).toBe("typescript");
    expect(inferFiletype("src/app.tsx")).toBe("typescriptreact");
    expect(inferFiletype("README.md")).toBe("markdown");
    expect(inferFiletype("data.json")).toBe("javascript");
  });

  test("classifies source and JSON for syntax rendering", () => {
    expect(classifyDetailContent(row())).toMatchObject({
      kind: "code",
      filetype: "typescript",
    });
    expect(classifyDetailContent(row({
      args: { path: "/tmp/data.json" },
      resultText: "{\"ok\":true,\"count\":2}",
    }))).toMatchObject({ kind: "json", filetype: "javascript" });
  });

  test("classifies lint and test lines semantically", () => {
    expect(classifyDiagnosticLine("error src/app.ts:12:4 Unexpected any").role).toBe("error");
    expect(classifyDiagnosticLine("warning src/app.ts:9:2 unused value").role).toBe("warning");
    expect(classifyDiagnosticLine("PASS test/app.test.ts").role).toBe("pass");
    expect(classifyDiagnosticLine("FAIL test/app.test.ts").role).toBe("fail");
    expect(classifyDiagnosticLine(" 37 pass").role).toBe("pass");
  });

  test("detects diagnostics before generic shell output", () => {
    const detail = classifyDetailContent(row({
      toolName: "start_process",
      args: { command: "bun test" },
      resultText: "37 pass\n0 fail\nRan 37 tests",
    }));
    expect(detail.kind).toBe("diagnostics");
  });

  test("keeps shell and unknown output readable", () => {
    expect(classifyDetailContent(row({
      toolName: "start_process",
      args: { command: "printf hello" },
      resultText: "hello\nworld",
    })).kind).toBe("shell");

    expect(classifyDetailContent(row({
      toolName: "custom_tool",
      args: {},
      resultText: "arbitrary human text",
    })).kind).toBe("plain");
  });

  test("uses error text when a failed call has no result", () => {
    const detail = classifyDetailContent(row({
      status: "failed",
      resultText: undefined,
      error: "ENOENT: missing file",
    }));
    expect(detail.content).toBe("ENOENT: missing file");
    expect(detail.source).toBe("error");
  });
});
