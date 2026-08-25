import { describe, expect, test } from "bun:test";
import { ProcessManager } from "../../src/process/manager";

describe("ProcessManager", () => {
  test("captures output from a completed command", async () => {
    const manager = new ProcessManager();
    const started = await manager.start(["bun", "-e", "console.info('hello')"]);
    const output = await manager.readOutput(started.id);
    expect(output).toMatchObject({ id: started.id, status: "completed", output: "hello\n", exitCode: 0 });
  });

  test("rejects an unknown process id", async () => {
    await expect(new ProcessManager().readOutput("missing")).rejects.toThrow(/unknown process/i);
  });

  test("redacts literal secrets from system process command lines", async () => {
    const secret = "dummy-sensitive-value-12345";
    const child = Bun.spawn(["python3", "-c", "import time; time.sleep(10)", "--api-key", secret]);
    try {
      const listed = (await new ProcessManager().listProcesses()).find(({ pid }) => pid === child.pid);
      expect(listed).toBeDefined();
      expect(listed?.command).toContain("--api-key [REDACTED]");
      expect(listed?.command).not.toContain(secret);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});
