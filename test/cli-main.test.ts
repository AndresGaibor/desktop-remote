import { describe, expect, test } from "bun:test";
import { runCli, type CliDependencies } from "../src/cli/main";

function deps(state: "running" | "stopped" = "running") {
  const calls: string[] = [];
  const output: string[] = [];
  const d: CliDependencies = {
    stdinIsTTY: true,
    readDesiredState: async () => state,
    service: {
      install: async () => { calls.push("install"); },
      start: async () => { calls.push("start"); return status(); },
      stop: async () => { calls.push("stop"); },
      restart: async () => { calls.push("restart"); return status(); },
      ensureRunning: async () => { calls.push("ensure"); return status(); },
      status: async () => status(),
    },
    attach: async () => { calls.push("attach"); },
    replay: async (file) => { calls.push(`replay:${file}`); },
    pipe: async () => { calls.push("pipe"); },
    logs: async (follow) => { calls.push(`logs:${follow}`); },
    daemon: async (args) => { calls.push(`daemon:${args.join(" ")}`); },
    mcpServe: async () => { calls.push("mcp"); },
    tunnelInit: async (args) => { calls.push(`tunnel-init:${args.join(" ")}`); },
    tunnelDoctor: async () => { calls.push("tunnel-doctor"); },
    tunnelStatus: async () => { calls.push("tunnel-status"); },
    doctor: async (format) => { calls.push(`doctor:${format}`); },
    update: async () => { calls.push("update"); },
    rollback: async () => { calls.push("rollback"); },
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(`ERR:${text}`),
  };
  return { d, calls, output };
}
function status() { return { state: "online" as const, restartCount: 0, consecutiveFailures: 0, startedAt: 1, retainedCalls: 0 }; }

describe("runCli", () => {
  test("default command never overrides intentional stop", async () => {
    const { d, calls, output } = deps("stopped");
    expect(await runCli([], d)).toBe(1);
    expect(calls).toEqual([]);
    expect(output.join("\n")).toMatch(/intentionally stopped/i);
  });
  test("default running flow ensures daemon then attaches", async () => {
    const { d, calls } = deps();
    expect(await runCli([], d)).toBe(0);
    expect(calls).toEqual(["ensure", "attach"]);
  });
  test("admin commands work without a TTY", async () => {
    const { d, calls } = deps(); d.stdinIsTTY = false;
    await runCli(["start"], d); await runCli(["status"], d); await runCli(["logs", "--follow"], d); await runCli(["stop"], d);
    expect(calls).toEqual(["start", "logs:true", "stop"]);
  });
  test("replay and daemon remain explicit while non-TTY default remains pipe mode", async () => {
    const { d, calls } = deps(); d.stdinIsTTY = false;
    await runCli([], d); await runCli(["replay", "x.jsonl"], d); await runCli(["daemon", "--cmd", "/tmp/fake"], d);
    expect(calls).toEqual(["pipe", "replay:x.jsonl", "daemon:--cmd /tmp/fake"]);
  });
  test("starts the MCP server with the mcp command", async () => {
    const { d, calls } = deps();
    expect(await runCli(["mcp"], d)).toBe(0);
    expect(calls).toEqual(["mcp"]);
  });
  test("supports tunnel init, doctor, and status commands", async () => {
    const { d, calls } = deps();
    expect(await runCli(["tunnel", "init", "--tunnel-id", "t", "--profile", "p"], d)).toBe(0);
    expect(await runCli(["tunnel", "doctor"], d)).toBe(0);
    expect(await runCli(["tunnel", "status"], d)).toBe(0);
    expect(calls).toEqual(["tunnel-init:--tunnel-id t --profile p", "tunnel-doctor", "tunnel-status"]);
  });
  test("requires tunnel init arguments", async () => {
    const { d, output } = deps();
    expect(await runCli(["tunnel", "init", "--profile", "p"], d)).toBe(1);
    expect(output.join("\n")).toMatch(/--tunnel-id/);
  });
  test("does not accept a literal tunnel secret", async () => {
    const { d, output } = deps();
    expect(await runCli(["tunnel", "init", "--tunnel-id", "t", "--profile", "sk-live-secret-value"], d)).toBe(1);
    expect(output.join("\n")).toMatch(/literal API key/i);
  });

  test("routes support-bundle and repair as explicit opt-in commands", async () => {
    const { d, calls } = deps();
    d.supportBundle = async (path) => { calls.push(`support-bundle:${path ?? "default"}`); return path; };
    d.repair = async () => { calls.push("repair"); };

    expect(await runCli(["support-bundle", "/tmp/diagnostics"], d)).toBe(0);
    expect(await runCli(["repair"], d)).toBe(0);
    expect(calls).toEqual(["support-bundle:/tmp/diagnostics", "repair"]);
  });
});
