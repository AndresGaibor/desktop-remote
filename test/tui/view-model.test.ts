import { describe, expect, test } from "bun:test";
import {
  buildActivityRows,
  buildContextSummary,
  buildEmptyState,
  connectionVisual,
  statusVisual,
} from "../../src/tui/view-model";
import type { SessionSnapshot } from "../../src/session/types";

function snapshot(): SessionSnapshot {
  const rows = [{
    callId: "call-1",
    toolName: "read_file",
    args: { path: "/project/src/index.ts" },
    metadata: {},
    status: "completed" as const,
    startedAt: 10,
    completedAt: 52,
    durationMs: 42,
    resultText: "export const answer = 42;",
  }];
  return {
    connection: "online",
    device: { user: "user@example.test", deviceId: "dev-1", deviceName: "mac.local" },
    rows,
    filteredRows: rows,
    selectedCall: rows[0],
    counts: { total: 1, running: 0, completed: 1, failed: 0 },
    query: "",
    statusFilter: "all",
  };
}
describe("OpenCode-style TUI view model", () => {
  test("builds a selected semantic activity row", () => {
    const row = buildActivityRows(snapshot(), 80)[0];

    expect(row?.text).toContain("✓ read_file");
    expect(row?.text).toContain("index.ts");
    expect(row?.text).toContain("42ms");
    expect(row?.selected).toBe(true);
    expect(row?.tone).toBe("success");
  });

  test("uses concise empty-state copy", () => {
    expect(buildEmptyState()).toEqual([
      "Waiting for tool calls…",
      "MCP activity will appear here automatically.",
    ]);
  });

  test("exposes semantic status and connection visuals", () => {
    expect(statusVisual("running")).toEqual({ glyph: "●", label: "running", tone: "warning" });
    expect(statusVisual("failed")).toEqual({ glyph: "✕", label: "failed", tone: "danger" });
    expect(connectionVisual("online")).toEqual({ glyph: "●", label: "online", tone: "success" });
  });

  test("builds a short contextual summary independent of split panes", () => {
    const summary = buildContextSummary(snapshot(), 120).join("\n");
    expect(summary).toContain("read_file");
    expect(summary).toContain("completed");
    expect(summary).toContain("42ms");
  });
});

test("wide terminals no longer force a split pane", async () => {
  const { shouldUseSplitPane } = await import("../../src/tui/view-model");
  expect(shouldUseSplitPane(200)).toBe(false);
  expect(shouldUseSplitPane(80)).toBe(false);
});
