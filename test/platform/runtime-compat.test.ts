import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const wrapper = join(repoRoot, "bin", "desktop-remote.js");
const bunPath = process.execPath;
const nodePath = await findExecutable("node");
if (!nodePath) throw new Error("Node.js executable not found for cross-runtime tests");

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("cross-runtime CLI bootstrap", () => {
  test("loads the TypeScript CLI under Node.js using local tsx", async () => {
    const result = await run([nodePath, wrapper, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: desktop-remote");
    expect(result.stderr).toBe("");
  });
  test("loads the same CLI under Bun", async () => {
    const result = await run([bunPath, wrapper, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: desktop-remote");
    expect(result.stderr).toBe("");
  });
});


describe("cross-runtime daemon core", () => {
  test("Node.js can import the daemon graph without OpenTUI", async () => {
    const result = await run([
      nodePath, "--import", "tsx", "--input-type=module", "-e",
      "await import('./src/daemon/run-daemon.ts'); console.log('daemon-ok')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("daemon-ok");
    expect(result.stderr).toBe("");
  });

  test("portable sleep keeps Node alive for daemon backoff", async () => {
    const result = await run([
      nodePath, "--import", "tsx", "--input-type=module", "-e",
      "const { sleep } = await import('./src/platform/runtime.ts'); await sleep(20); console.log('awake')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("awake");
  });
});

async function findExecutable(name: string): Promise<string | undefined> {
  const candidates = [
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name))),
    join(process.env.HOME ?? "", ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}
