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
});
