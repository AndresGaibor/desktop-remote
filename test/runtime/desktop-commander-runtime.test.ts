import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DesktopCommanderRuntime,
  MAX_UPSTREAM_REMAINDER_BYTES,
  type ChildProcessLike,
  type SpawnProcess,
} from "../../src/runtime/desktop-commander-runtime";
import type { RuntimeEvent } from "../../src/runtime/events";

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills: NodeJS.Signals[] = [];
  closeOnSigint = true;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    if (signal === "SIGINT" && this.closeOnSigint) {
      queueMicrotask(() => this.emit("close", 0, null));
    }
    return true;
  }
}

function setupRuntime(child = new FakeChild()) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnProcess: SpawnProcess = (command, args) => {
    calls.push({ command, args });
    return child;
  };
  const runtime = new DesktopCommanderRuntime({ spawnProcess, shutdownTimeoutMs: 5 });
  return { runtime, child, calls };
}

describe("DesktopCommanderRuntime", () => {
  test("launches the official local executable with remote arguments", () => {
    const { runtime, calls } = setupRuntime();

    runtime.start();

    expect(calls).toEqual([
      { command: "desktop-commander", args: ["remote", "--persist-session"] },
    ]);
  });

  test("turns child stdout into typed runtime events", async () => {
    const { runtime, child } = setupRuntime();
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    runtime.start();

    child.stdout.write(
      '🔧 Received tool call call-1: read_file {"path":"/tmp/a"} metadata: {}\n',
    );
    await Bun.sleep(0);

    expect(events[0]).toMatchObject({ type: "tool.started", callId: "call-1" });
  });

  test("uses SIGINT so Desktop Commander owns graceful shutdown", async () => {
    const { runtime, child } = setupRuntime();
    runtime.start();

    await runtime.stop();

    expect(child.kills).toEqual(["SIGINT"]);
  });

  test("escalates to SIGKILL only when graceful shutdown times out", async () => {
    const child = new FakeChild();
    child.closeOnSigint = false;
    const { runtime } = setupRuntime(child);
    runtime.start();

    await runtime.stop();

    expect(child.kills).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("bounds an unterminated upstream remainder and recovers on later lines", async () => {
    const { runtime, child } = setupRuntime();
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    runtime.start();

    child.stdout.write("x".repeat(MAX_UPSTREAM_REMAINDER_BYTES + 1024));
    await Bun.sleep(0);

    expect(events.some((event) => event.type === "runtime.error" && event.message.includes("2 MiB"))).toBe(true);
    child.stdout.write('🔧 Received tool call recovered: read_file {"path":"/tmp/a"} metadata: {}\n');
    await Bun.sleep(0);
    expect(events.some((event) => event.type === "tool.started" && event.callId === "recovered")).toBe(true);
  });

  test("exposes child pid/running and ignores old streams after close", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    second.pid = 5252;
    const children = [first, second];
    const runtime = new DesktopCommanderRuntime({
      spawnProcess: () => children.shift()!,
      shutdownTimeoutMs: 5,
    });
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    runtime.start();
    expect(runtime.running).toBe(true);
    expect(runtime.pid).toBe(4242);
    first.emit("close", 1, null);
    await Bun.sleep(0);
    expect(runtime.running).toBe(false);

    runtime.start();
    expect(runtime.pid).toBe(5252);
    first.stdout.write('🔧 Received tool call stale: read_file {} metadata: {}\n');
    second.stdout.write('🔧 Received tool call fresh: read_file {} metadata: {}\n');
    await Bun.sleep(0);
    expect(events.some((event) => event.type === "tool.started" && event.callId === "stale")).toBe(false);
    expect(events.some((event) => event.type === "tool.started" && event.callId === "fresh")).toBe(true);
  });

});
