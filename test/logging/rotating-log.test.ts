import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotatingDaemonLog } from "../../src/logging/rotating-log";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeLog(options: { maxBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-log-"));
  directories.push(directory);
  const path = join(directory, "daemon.log");
  return {
    directory,
    path,
    log: new RotatingDaemonLog({ path, ...options }),
  };
}

describe("RotatingDaemonLog", () => {
  test("redacts credentials in messages and nested structured data", async () => {
    const { directory, path, log } = await makeLog({ maxBytes: 8_192 });
    const rawApiKey = "sk-live-do-not-log-0123456789";
    const githubPat = "github_pat_11AAABBBCCCDDDEEEFFF";
    const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const slackToken = "xox" + "b-1234567890-abcdefghijklmnop";

    await log.warn(
      `authentication failed at https://example.test/device?token=url-secret api=${rawApiKey}`,
      {
        authorization: "Bearer abc.def.ghi",
        verificationCode: "ABCD-EFGH",
        nested: {
          password: "password-secret",
          authUrl: "https://example.test/device?token=query-secret",
          diagnostic: `transport error ${rawApiKey} ${githubPat} ${githubToken} ${slackToken}`,
        },
      },
    );

    const contents = await readFile(path, "utf8");
    const record = JSON.parse(contents) as {
      timestamp: string;
      level: string;
      message: string;
      data: unknown;
    };

    expect(record).toMatchObject({ level: "warn" });
    expect(record.timestamp).toBeString();
    expect(contents).not.toContain("abc.def.ghi");
    expect(contents).not.toContain("ABCD-EFGH");
    expect(contents).not.toContain("password-secret");
    expect(contents).not.toContain("url-secret");
    expect(contents).not.toContain("query-secret");
    expect(contents).not.toContain(rawApiKey);
    expect(contents).not.toContain(githubPat);
    expect(contents).not.toContain(githubToken);
    expect(contents).not.toContain(slackToken);
    expect(await stat(path).then((result) => result.mode & 0o777)).toBe(0o600);
    expect((await readdir(directory)).filter((entry) => entry.startsWith("daemon.log"))).toEqual([
      "daemon.log",
    ]);
  });

  test("rotates before append, serializes concurrent writes, and keeps three bounded files", async () => {
    const { directory, path, log } = await makeLog({ maxBytes: 300 });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        log.warn(`operational warning ${index}`, { index, detail: "x".repeat(60) })),
    );

    const names = (await readdir(directory)).filter((entry) => entry.startsWith("daemon.log")).sort();
    expect(names).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2"]);
    expect(names).not.toContain("daemon.log.3");

    const files = await Promise.all(names.map(async (name) => {
      const filePath = join(directory, name);
      const fileStat = await stat(filePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(fileStat.size).toBeLessThanOrEqual(300);
      return readFile(filePath, "utf8");
    }));
    const records = files.flatMap((contents) => contents.trim().split("\n").filter(Boolean));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((line) => {
      JSON.parse(line);
      return true;
    })).toBe(true);
    expect(await log.totalSizeBytes()).toBeLessThanOrEqual(900);
  });
});
