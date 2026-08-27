import { describe, expect, test } from "bun:test";
import { MacAutomation, type CommandRunner } from "../../src/macos/automation";

type Call = {
  command: string;
  args: readonly string[];
  input?: string;
};

function runnerFor(responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    const response = responses[command] ?? { exitCode: 0 };
    return { exitCode: response.exitCode, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { calls, runner };
}

describe("MacAutomation", () => {
  test("rejects every operation outside macOS without invoking a command", async () => {
    const { calls, runner } = runnerFor();
    const automation = new MacAutomation(runner, { platform: "linux" });

    await expect(automation.getActiveWindow()).rejects.toThrow(/macOS.*only|unsupported/i);
    expect(calls).toHaveLength(0);
  });

  test("reads the active window from the bounded osascript response", async () => {
    const { calls, runner } = runnerFor({
      osascript: { exitCode: 0, stdout: "Code Editor\tmain.ts\n" },
    });
    const automation = new MacAutomation(runner, { platform: "darwin" });

    await expect(automation.getActiveWindow()).resolves.toEqual({ app: "Code Editor", title: "main.ts" });
    expect(calls[0]).toMatchObject({ command: "osascript" });
    expect(calls[0]?.args.join(" ")).toContain("frontmost");
  });

  test("parses and bounds the list of windows", async () => {
    const { runner } = runnerFor({
      osascript: { exitCode: 0, stdout: "Code Editor\tmain.ts\nSafari\tDocs\n" },
    });
    const automation = new MacAutomation(runner, { platform: "darwin", maxWindows: 1 });

    await expect(automation.listWindows()).resolves.toEqual({
      windows: [{ app: "Code Editor", title: "main.ts" }],
      truncated: true,
    });
  });

  test("gets and sets clipboard through pbpaste and pbcopy without exposing command output", async () => {
    const { calls, runner } = runnerFor({
      pbpaste: { exitCode: 0, stdout: "private note" },
      pbcopy: { exitCode: 0 },
    });
    const automation = new MacAutomation(runner, { platform: "darwin" });

    await expect(automation.clipboardGet()).resolves.toEqual({ text: "private note", bytes: 12, truncated: false });
    await expect(automation.clipboardSet("private note")).resolves.toEqual({ set: true, bytes: 12 });
    expect(calls[0]?.command).toBe("pbpaste");
    expect(calls[1]).toMatchObject({ command: "pbcopy", input: "private note" });
  });

  test("captures only screenshot path and metadata", async () => {
    const { calls, runner } = runnerFor({ screencapture: { exitCode: 0 } });
    const automation = new MacAutomation(runner, { platform: "darwin" });

    await expect(automation.screenshot({ path: "/tmp/desktop-remote-test.png" })).resolves.toEqual({
      path: "/tmp/desktop-remote-test.png",
      format: "png",
      captured: true,
    });
    expect(calls[0]).toMatchObject({ command: "screencapture" });
    expect(calls[0]?.args).toContain("/tmp/desktop-remote-test.png");
  });

  test("turns accessibility failures into actionable permission guidance", async () => {
    const { runner } = runnerFor({
      osascript: {
        exitCode: 1,
        stderr: "Not authorised to send Apple events to System Events.",
      },
    });
    const automation = new MacAutomation(runner, { platform: "darwin" });

    await expect(automation.getActiveWindow()).rejects.toThrow(/Accessibility.*Privacy.*Security/i);
  });
});
