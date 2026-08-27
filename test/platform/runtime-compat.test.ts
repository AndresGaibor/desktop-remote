import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const wrapper = join(repoRoot, "bin", "desktop-remote.js");
const bunPath = process.execPath;
const nodePath = await findExecutable("node");
if (!nodePath) throw new Error("Node.js executable not found for cross-runtime tests");
const nodeExecutable = nodePath;

async function run(command: string[]) {
  const normalizedCommand = command[0] === nodeExecutable ? [nodeExecutable, "--no-warnings", ...command.slice(1)] : command;
  const child = Bun.spawn(normalizedCommand, {
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
    const result = await run([nodeExecutable, wrapper, "--help"]);
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
      nodeExecutable, "--import", "tsx", "--input-type=module", "-e",
      "await import('./src/daemon/run-daemon.ts'); console.log('daemon-ok')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("daemon-ok");
    expect(result.stderr).toBe("");
  });

  test("Node.js can spawn and collect a managed process without Bun globals", async () => {
    const result = await run([
      nodeExecutable, "--import", "tsx", "--input-type=module", "-e",
      "const { ProcessManager } = await import('./src/process/manager.ts'); const manager = new ProcessManager(); const started = await manager.start([process.execPath, '-e', \"process.stdout.write('node-process-ok')\"]); const output = await manager.readOutput(started.id); if (output.output !== 'node-process-ok' || output.status !== 'completed') process.exit(1); console.log('process-ok')",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("process-ok");
    expect(result.stderr).toBe("");
  });

  test("portable sleep keeps Node alive for daemon backoff", async () => {
    const result = await run([
      nodeExecutable, "--import", "tsx", "--input-type=module", "-e",
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
