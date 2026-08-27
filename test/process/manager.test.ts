import { describe, expect, test } from "bun:test";
import { ProcessManager } from "../../src/process/manager";

const MB = 1024 * 1024;

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
