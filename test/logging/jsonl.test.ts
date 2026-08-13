import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent } from "../../src/runtime/events";
import { redactEvent } from "../../src/logging/redactor";
import { JsonlEventWriter, readJsonlEvents } from "../../src/logging/jsonl";

const files: string[] = [];
afterEach(async () => {
  await Promise.all(files.splice(0).map((path) => rm(path, { force: true })));
});

describe("event redaction", () => {
  test("removes auth codes and common secret fields recursively", () => {
    const event: RuntimeEvent = {
      type: "tool.started",
      callId: "call-1",
      toolName: "start_process",
      args: { refreshToken: "refresh-secret", password: "pw" },
      metadata: {
        authorization: "Bearer abc.def.ghi",
        cookie: "session=secret",
        nested: { access_token: "access-secret" },
      },
      startedAt: 1,
    };

    const redacted = redactEvent(event) as Extract<RuntimeEvent, { type: "tool.started" }>;
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain('"pw"');
    expect(serialized).toContain("[REDACTED]");
  });

  test("redacts the Desktop Commander verification code", () => {
    const event: RuntimeEvent = {
      type: "auth.required",
      url: "https://example.test/device",
      code: "ABCD-EFGH",
      expiresIn: "15 minutes",
      at: 1,
    };

    const redacted = redactEvent(event);
    expect(JSON.stringify(redacted)).not.toContain("ABCD-EFGH");
  });
});

describe("JSONL event log", () => {
  test("writes redacted events and reads them back", async () => {
    const path = join(tmpdir(), `desktop-remote-${crypto.randomUUID()}.jsonl`);
    files.push(path);
    const writer = new JsonlEventWriter(path);
    const event: RuntimeEvent = {
      type: "auth.required",
      url: "https://example.test/device",
      code: "WXYZ-1234",
      expiresIn: "15 minutes",
      at: 10,
    };

    writer.write(event);
    await writer.close();

    const raw = await Bun.file(path).text();
    expect(raw).not.toContain("WXYZ-1234");
    const events = await readJsonlEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("auth.required");
  });

  test("reports the line number for malformed replay logs", async () => {
    const path = join(tmpdir(), `desktop-remote-bad-${crypto.randomUUID()}.jsonl`);
    files.push(path);
    await Bun.write(path, '{"type":"runtime.log","source":"stdout","message":"ok","at":1}\nnot-json\n');

    await expect(readJsonlEvents(path)).rejects.toThrow("line 2");
  });
});
