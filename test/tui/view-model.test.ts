import { describe, expect, test } from "bun:test";
import {
  buildDetailLines,
  buildStatusLine,
  buildTimelineRows,
  shouldUseSplitPane,
} from "../../src/tui/view-model";
import type { SessionSnapshot } from "../../src/session/types";

function snapshot(): SessionSnapshot {
  const rows = [
    {
      callId: "call-1",
      toolName: "read_file",
      args: { path: "/project/src/index.ts" },
      metadata: {},
      status: "completed" as const,
      startedAt: 10,
      completedAt: 52,
      durationMs: 42,
      resultText: "export const answer = 42;",
    },
  ];
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

describe("TUI view model", () => {
  test("builds concise timeline rows with selection and duration", () => {
    const rows = buildTimelineRows(snapshot(), 80);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("read_file");
    expect(rows[0]).toContain("42ms");
    expect(rows[0]).toContain("index.ts");
  });

  test("builds detail lines from the selected call", () => {
    const lines = buildDetailLines(snapshot(), 80);
    const text = lines.join("\n");

    expect(text).toContain("read_file");
    expect(text).toContain("/project/src/index.ts");
    expect(text).toContain("export const answer = 42;");
  });

  test("builds a compact status footer", () => {
    const line = buildStatusLine(snapshot(), 100);

    expect(line).toContain("1 calls");
    expect(line).toContain("✓ 1");
    expect(line).toContain("running 0");
    expect(line).toContain("online");
  });

  test("uses split pane only when there is enough width", () => {
    expect(shouldUseSplitPane(120)).toBe(true);
    expect(shouldUseSplitPane(79)).toBe(false);
  });
});
