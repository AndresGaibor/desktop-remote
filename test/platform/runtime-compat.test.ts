import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const wrapper = join(repoRoot, "bin", "desktop-remote.js");

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
    const result = await run([process.execPath.includes("bun") ? "node" : process.execPath, wrapper, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: desktop-remote");
    expect(result.stderr).toBe("");
  });
  test("loads the same CLI under Bun", async () => {
    const result = await run(["bun", wrapper, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: desktop-remote");
    expect(result.stderr).toBe("");
  });
});


describe("cross-runtime daemon core", () => {
  test("Node.js can import the daemon graph without OpenTUI", async () => {
    const result = await run([
      "node", "--import", "tsx", "--input-type=module", "-e",
      "await import('./src/daemon/run-daemon.ts'); console.log('daemon-ok')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("daemon-ok");
    expect(result.stderr).toBe("");
  });

  test("portable sleep keeps Node alive for daemon backoff", async () => {
    const result = await run([
      "node", "--import", "tsx", "--input-type=module", "-e",
      "const { sleep } = await import('./src/platform/runtime.ts'); await sleep(20); console.log('awake')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("awake");
  });
});
