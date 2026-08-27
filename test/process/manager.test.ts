import { afterEach, describe, expect, test } from "bun:test";
import { spawn as spawnUnmanaged } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../../src/process/manager";
import { outputSchemas } from "../../src/mcp/output-schemas";
import { toolSchemas } from "../../src/mcp/schemas";

const MB = 1024 * 1024;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProcessManager.readOutput no bloqueante", () => {
  test("devuelve status running con output parcial sin esperar a que termine el proceso", async () => {
    const manager = new ProcessManager();
    const started = await manager.start(`bun -e "process.stdout.write('partial\\n'); setTimeout(() => {}, 3000)"`);
    const start = Date.now();
    const output = await manager.readOutput(started.id);
    const elapsed = Date.now() - start;
    expect(output.status).toBe("running");
    expect(output.output).toContain("partial");
    expect(elapsed).toBeLessThan(2000);
  });

  test("acepta cwd y overrides de entorno, y separa stdout de stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-process-"));
    directories.push(directory);
    const manager = new ProcessManager();
    const started = await manager.start([
      process.execPath,
      "-e",
      "process.stdout.write(process.cwd()); process.stderr.write(process.env.PROCESS_MANAGER_MARKER ?? '')",
    ], { cwd: directory, env: { PROCESS_MANAGER_MARKER: "stderr-only" } });

    const resolved = await realpath(directory);
    const result = await manager.readOutput(started.id, { timeout_ms: 5000 });
    expect(result.cwd).toBe(directory);
    expect(result.stdout).toBe(resolved);
    expect(result.stderr).toBe("stderr-only");
    expect(result.output).toContain(resolved);
    expect(result.output).toContain("stderr-only");

    const session = manager.listSessions().find((candidate) => candidate.id === started.id);
    expect(session).toMatchObject({ cwd: directory });
    expect(Object.keys(session ?? {})).not.toContain("env");
  });

  test("un proceso corto se reporta completed sin timeout explicito", async () => {
    const manager = new ProcessManager();
    const started = await manager.start(`bun -e "process.stdout.write('done\\n')"`);
    const output = await manager.readOutput(started.id);
    expect(output.status).toBe("completed");
    expect(output.output).toContain("done");
    expect(output.exitCode).toBe(0);
  });

  test("timeout_ms acota la espera aunque el proceso siga vivo", async () => {
    const manager = new ProcessManager();
    const started = await manager.start(`bun -e "process.stdout.write('x\\n'); const s = Date.now(); while(Date.now()-s < 5000) {}"`);
    const start = Date.now();
    const output = await manager.readOutput(started.id, { timeout_ms: 300 });
    expect(output.status).toBe("running");
    expect(Date.now() - start).toBeLessThan(2000);
  }, 10000);

  test("timeout_ms termina el proceso y expone que se agotó el plazo", async () => {
    const manager = new ProcessManager();
    const started = await manager.start([
      process.execPath,
      "-e",
      "setInterval(() => {}, 10000)",
    ], { timeout_ms: 50 });

    const output = await manager.readOutput(started.id, { timeout_ms: 3000 });
    expect(output.status).toBe("failed");
    expect(output.timedOut).toBe(true);
  }, 10000);
});

describe("ProcessManager ring buffer acotado", () => {
  test("no retiene output sin limite bajo salida grande", async () => {
    const manager = new ProcessManager({ maxOutputBytes: 64 * 1024 });
    const largeSize = 512 * 1024;
    const started = await manager.start(
      `bun -e "for (let i = 0; i < ${largeSize}; i++) process.stdout.write('x')"`,
    );
    await manager.readOutput(started.id, { timeout_ms: 5000 });
    const session = manager.listSessions().find((s) => s.id === started.id);
    expect(session?.output.length).toBeLessThanOrEqual(64 * 1024 + 1024);
  });

  test("ring buffer descarta las entradas mas antiguas", async () => {
    const manager = new ProcessManager({ maxOutputBytes: 100 });
    const started = await manager.start(`bun -e "process.stdout.write('${"a".repeat(60)}${"b".repeat(60)}${"c".repeat(60)}')"`);
    await manager.readOutput(started.id, { timeout_ms: 5000 });
    const session = manager.listSessions().find((s) => s.id === started.id);
    const output = session?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(200);
    expect(output.includes("c")).toBe(true);
  });

  test("acota stdout y stderr por bytes sin romper UTF-8", async () => {
    const manager = new ProcessManager({ maxOutputBytes: 8 });
    const started = await manager.start([
      process.execPath,
      "-e",
      "process.stdout.write('inicio-😀-fin'); process.stderr.write('error-😀-fin')",
    ]);

    const output = await manager.readOutput(started.id, { timeout_ms: 5000 });
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(8);
    expect(output.stdout).not.toContain("�");
    expect(output.stderr).not.toContain("�");
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stderrTruncated).toBe(true);
    expect(output.stdoutBytes).toBeGreaterThan(output.stdoutRetainedBytes);
    expect(output.stderrBytes).toBeGreaterThan(output.stderrRetainedBytes);
  });

  test("permite paginar stdout con cursores de bytes", async () => {
    const manager = new ProcessManager({ maxOutputBytes: 100 });
    const started = await manager.start([process.execPath, "-e", "process.stdout.write('0123456789')"]);

    const output = await manager.readOutput(started.id, {
      timeout_ms: 5000,
      stdout_offset: 2,
      stdout_length: 3,
    });
    expect(output.stdout).toBe("234");
    expect(output.stdoutCursor).toMatchObject({ offset: 2, end: 5, nextOffset: 10, truncated: false });
  });
});

describe("ProcessManager lifecycle y retención", () => {
  test("envía SIGTERM antes de escalar a una terminación forzada", async () => {
    const manager = new ProcessManager();
    const started = await manager.start([
      process.execPath,
      "-e",
      "process.stdout.write('ready'); process.on('SIGTERM', () => { process.stdout.write('graceful'); process.exit(0) }); setInterval(() => {}, 10000)",
    ]);

    await manager.readOutput(started.id, { timeout_ms: 1000 });
    await manager.terminate(started.pid);
    const output = await manager.readOutput(started.id, { timeout_ms: 1000 });
    expect(output.output).toContain("graceful");
  });

  test("termina el grupo de procesos creado por el manager", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-process-group-"));
    directories.push(directory);
    const childReady = join(directory, "child-ready");
    const marker = join(directory, "child-terminated");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(childReady)}, 'ready'); process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'terminated'); process.exit(0) }); setInterval(() => {}, 10000)`;
    const parentCode = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', detached: false }); process.stdout.write('ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 10000)`;
    const manager = new ProcessManager({ gracefulTerminateMs: 100 });
    const started = await manager.start([process.execPath, "-e", parentCode]);

    await manager.readOutput(started.id, { timeout_ms: 1000 });
    await Bun.sleep(50);
    await expect(readFile(childReady, "utf8")).resolves.toBe("ready");
    await manager.terminate(started.pid);
    await expect(readFile(marker, "utf8")).resolves.toBe("terminated");
  });

  test("no permite matar procesos que no creó el manager", async () => {
    const unrelated = spawnUnmanaged(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
    try {
      expect(unrelated.pid).toBeGreaterThan(0);
      await expect(new ProcessManager().kill(unrelated.pid!)).rejects.toThrow(/managed|unknown/i);
      expect(unrelated.exitCode).toBeNull();
    } finally {
      unrelated.kill("SIGKILL");
    }
  });

  test("evicta la sesión completada más antigua al superar el límite", async () => {
    const manager = new ProcessManager({ maxRetainedSessions: 1, completedSessionTtlMs: 10_000 });
    const first = await manager.start([process.execPath, "-e", "process.exit(0)"]);
    await manager.readOutput(first.id, { timeout_ms: 5000 });
    const second = await manager.start([process.execPath, "-e", "process.exit(0)"]);
    await manager.readOutput(second.id, { timeout_ms: 5000 });

    expect(manager.listSessions().map((session) => session.id)).toEqual([second.id]);
  });

  test("evicta sesiones completadas después del TTL configurable", async () => {
    const manager = new ProcessManager({ completedSessionTtlMs: 25 });
    const started = await manager.start([process.execPath, "-e", "process.exit(0)"]);
    await manager.readOutput(started.id, { timeout_ms: 5000 });
    expect(manager.listSessions()).toHaveLength(1);

    await Bun.sleep(100);
    expect(manager.listSessions()).toHaveLength(0);
  });
});

describe("contrato MCP de procesos", () => {
  test("publica opciones de proceso y metadatos de salida acotada", () => {
    expect(Object.keys(toolSchemas.start_process.shape)).toEqual(expect.arrayContaining(["cwd", "env", "timeout_ms"]));
    expect(Object.keys(toolSchemas.read_process_output.shape)).toEqual(expect.arrayContaining([
      "timeout_ms", "stdout_offset", "stdout_length", "stderr_offset", "stderr_length",
    ]));
    expect(outputSchemas.read_process_output.safeParse({
      id: "session",
      pid: 123,
      cwd: "/tmp",
      status: "completed",
      output: "combined",
      stdout: "out",
      stderr: "err",
      outputBytes: 6,
      outputRetainedBytes: 6,
      stdoutBytes: 3,
      stderrBytes: 3,
      stdoutRetainedBytes: 3,
      stderrRetainedBytes: 3,
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      truncated: false,
      outputCursor: { offset: 0, end: 6, nextOffset: 6, truncated: false },
      stdoutCursor: { offset: 0, end: 3, nextOffset: 3, truncated: false },
      stderrCursor: { offset: 0, end: 3, nextOffset: 3, truncated: false },
    }).success).toBe(true);
  });
});

describe("ProcessManager concurrencia", () => {
  test("start rechaza cuando se excede maxConcurrentProcesses", async () => {
    const manager = new ProcessManager({ maxConcurrentProcesses: 2 });
    const p1 = await manager.start(`bun -e "const s = Date.now(); while(Date.now()-s < 10000) {}"`);
    const p2 = await manager.start(`bun -e "const s = Date.now(); while(Date.now()-s < 10000) {}"`);
    await expect(manager.start(`bun -e "process.exit(0)"`)).rejects.toThrow(/concurrent/i);
    await manager.kill(p1.pid);
    await manager.kill(p2.pid);
  });

  test("listProcesses devuelve procesos del sistema", async () => {
    const manager = new ProcessManager();
    const processes = await manager.listProcesses();
    expect(Array.isArray(processes)).toBe(true);
    expect(processes.length).toBeGreaterThan(0);
    const current = processes.find((p) => p.pid === process.pid);
    expect(current).toBeDefined();
    expect(current?.command).toBeDefined();
  });

  test("kill termina un proceso y listProcesses lo refleja", async () => {
    const manager = new ProcessManager();
    const started = await manager.start(`bun -e "const s = Date.now(); while(Date.now()-s < 10000) {}"`);
    const result = await manager.kill(started.pid);
    expect(result.killed).toBe(true);
    expect(result.pid).toBe(started.pid);
    await Bun.sleep(200);
    const session = manager.listSessions().find((s) => s.id === started.id);
    expect(session?.status).toBe("failed");
  });
});
