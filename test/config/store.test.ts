import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/store";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("ConfigStore tool-call persistence", () => {
  test("persists bounded redacted summaries instead of raw tool payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-config-store-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    const store = new ConfigStore(path);
    const secrets = [
      "sk-live-abcdefghijklmnopqrstuvwxyz",
      "Bearer abc.def.ghi",
      "github_pat_11AAABBBCCCDDDEEEFFF",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "xox" + "b-1234567890-abcdefghijklmnop",
    ];
    const huge = `prefix-${secrets.join("-")}-${"x".repeat(20_000)}`;

    await store.recordToolCall({
      toolName: "write_file",
      arguments: { path: "/tmp/example.txt", content: huge, command: `curl -H 'Authorization: ${secrets[1]}' ${secrets[2]}` },
      result: { path: "/tmp/example.txt", echo: huge },
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      durationMs: 1,
    });

    const persisted = await readFile(path, "utf8");
    for (const secret of secrets) expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("x".repeat(5000));
    expect(Buffer.byteLength(persisted)).toBeLessThan(8_000);

    const [call] = await store.getRecentToolCalls({ maxResults: 1 });
    expect(call?.toolName).toBe("write_file");
    expect(JSON.stringify(call?.arguments)).not.toContain(huge);
  });
});
