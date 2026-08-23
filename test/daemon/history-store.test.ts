import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_MAX_BYTES, HistoryStore } from "../../src/daemon/history-store";
import { RuntimeSessionStore } from "../../src/session/runtime-store";
import type { RuntimeEvent } from "../../src/runtime/events";

describe("HistoryStore", () => {
  test("compacts and restores only the latest 50 bounded calls", async () => {
    const path = await tempHistoryPath();
    const history = new HistoryStore({ path });
    const store = new RuntimeSessionStore();
    for (let index = 0; index < 75; index += 1) {
      const event = started(index, "x".repeat(80 * 1024));
      store.consume(event);
      await history.append(event, store.snapshot());
    }
    await history.compact(store.snapshot());

    const restored = new RuntimeSessionStore();
    await history.loadInto(restored);
    const rows = restored.snapshot().rows;
    expect(rows).toHaveLength(50);
    expect(rows[0]?.callId).toBe("call-25");
    expect(rows.at(-1)?.callId).toBe("call-74");
  });

  test("never persists live authentication URL or verification code", async () => {
    const path = await tempHistoryPath();
    const history = new HistoryStore({ path });
    const store = new RuntimeSessionStore();
    const auth: RuntimeEvent = {
      type: "auth.required",
      url: "https://example.test/login?secret=VERY_SECRET",
      code: "ABCD-EFGH",
      expiresIn: "5m",
      at: 1,
    };
    store.consume(auth);
    await history.append(auth, store.snapshot());
    await history.compact(store.snapshot());
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("VERY_SECRET");
    expect(text).not.toContain("ABCD-EFGH");
    expect(text).not.toContain("auth.required");
  });

  test("redacts secrets from persisted tool events and checkpoints", async () => {
    const path = await tempHistoryPath();
    const history = new HistoryStore({ path });
    const store = new RuntimeSessionStore();
    const start: RuntimeEvent = {
      type: "tool.started", callId: "secret-call", toolName: "start_process",
      args: { password: "started-password", authorization: "Bearer started-token" },
      metadata: { apiKey: "metadata-api-key" }, startedAt: 1,
    };
    const complete: RuntimeEvent = {
      type: "tool.completed", callId: "secret-call", toolName: "start_process",
      resultText: "Bearer completed-result-token", completedAt: 2,
    };
    store.consume(start); await history.append(start, store.snapshot());
    store.consume(complete); await history.append(complete, store.snapshot());

    const eventText = await readFile(path, "utf8");
    for (const secret of ["started-password", "started-token", "metadata-api-key", "completed-result-token"]) {
      expect(eventText).not.toContain(secret);
    }
    expect(eventText).toContain("[REDACTED]");

    await history.compact(store.snapshot());
    const checkpointText = await readFile(path, "utf8");
    for (const secret of ["started-password", "started-token", "metadata-api-key", "completed-result-token"]) {
      expect(checkpointText).not.toContain(secret);
    }
    expect(checkpointText).toContain("[REDACTED]");
  });

  test("stops at an injected byte limit before reading a giant history line", async () => {
    const path = await tempHistoryPath();
    const warnings: string[] = [];
    const history = new HistoryStore({ path, maxBytes: 512, onWarning: (message) => warnings.push(message) });
    const prefix = started(1, "valid-prefix");
    const prefixStore = new RuntimeSessionStore();
    prefixStore.consume(prefix);
    await history.append(prefix, prefixStore.snapshot());
    await appendFile(
      path,
      `${JSON.stringify({ stateVersion: 1, kind: "event", event: started(2, "x".repeat(8_000)) })}\n`,
      "utf8",
    );

    const restored = new RuntimeSessionStore();
    await history.loadInto(restored);
    expect(restored.snapshot().rows.map((row) => row.callId)).toEqual(["call-1"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/exceeds|maximum|corrupt|limit/i);
    expect(HISTORY_MAX_BYTES).toBe(24 * 1024 * 1024);
  });

  test("compacts automatically before the configured file ceiling", async () => {
    const path = await tempHistoryPath();
    const history = new HistoryStore({ path, compactAtBytes: 2_000, maxBytes: 8_000 });
    const store = new RuntimeSessionStore();
    for (let index = 0; index < 30; index += 1) {
      const event = started(index, "payload".repeat(30));
      store.consume(event);
      await history.append(event, store.snapshot());
      expect((await stat(path)).size).toBeLessThanOrEqual(8_000);
    }
    expect(await history.sizeBytes()).toBeLessThanOrEqual(8_000);
  });

  test("keeps the valid prefix and warns once on a corrupt suffix", async () => {
    const path = await tempHistoryPath();
    const warnings: string[] = [];
    const history = new HistoryStore({ path, onWarning: (message) => warnings.push(message) });
    const store = new RuntimeSessionStore();
    const event = started(1, "ok");
    store.consume(event);
    await history.append(event, store.snapshot());
    await appendFile(path, "not-json\n", "utf8");
    await appendFile(path, JSON.stringify({ stateVersion: 999, kind: "event", event }) + "\n", "utf8");

    const restored = new RuntimeSessionStore();
    await history.loadInto(restored);
    expect(restored.snapshot().rows.map((row) => row.callId)).toEqual(["call-1"]);
    expect(warnings).toHaveLength(1);
  });
});

async function tempHistoryPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dr-history-"));
  return join(dir, "history.jsonl");
}

function started(index: number, payload: string): RuntimeEvent {
  return {
    type: "tool.started",
    callId: `call-${index}`,
    toolName: "read_file",
    args: { path: `/${index}`, payload },
    metadata: {},
    startedAt: index,
  };
}
