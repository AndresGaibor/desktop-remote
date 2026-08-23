import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonIpcServer, type IpcDaemonSource } from "../src/daemon/ipc-server";
import { DesktopRemoteIpcClient } from "../src/client/ipc-client";
import { RuntimeSessionStore } from "../src/session/runtime-store";
import { makePaths } from "./soak-paths";
import type { RuntimeEvent } from "../src/runtime/events";

const durationMs = Number.parseInt(process.env.SOAK_DURATION_MS ?? "1800000", 10);
if (!Number.isFinite(durationMs) || durationMs < 1_000) throw new Error("SOAK_DURATION_MS must be >= 1000");
const dir = await mkdtemp(join(tmpdir(), "desktop-remote-soak-real-"));
const paths = makePaths(dir);
const store = new RuntimeSessionStore();
const source = makeSource(store);
const ipc = new DaemonIpcServer({ source, paths });
await ipc.start();
const started = Date.now();
const fdWarm = await fdCount();
let warmRss = 0;
let cycles = 0;
let nextSample = started;

while (Date.now() - started < durationMs) {
  const client = new DesktopRemoteIpcClient({ socketPath: paths.socketPath, requestTimeoutMs: 2_000 });
  await client.connect("visual");
  await client.requestSnapshot();
  await Bun.sleep(25);
  await client.close();
  cycles += 1;
  if (Date.now() >= nextSample) {
    forceGc();
    const rss = process.memoryUsage().rss;
    if (!warmRss) warmRss = rss;
    const allowed = Math.max(64 * 1024 * 1024, Math.floor(warmRss * 0.25));
    if (rss - warmRss > allowed) throw new Error(`real soak RSS growth exceeded limit: ${rss - warmRss}`);
    nextSample = Date.now() + 60_000;
  }
  await Bun.sleep(75);
}
await ipc.stop();
await Bun.sleep(20);
forceGc();
const fdEnd = await fdCount();
if (fdEnd - fdWarm > 4) throw new Error(`real soak FD growth exceeded limit: ${fdEnd - fdWarm}`);
console.log(JSON.stringify({ durationMs, cycles, warmRss, endRss: process.memoryUsage().rss, fdWarm, fdEnd }, null, 2));

function makeSource(session: RuntimeSessionStore): IpcDaemonSource {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    snapshot: () => session.snapshot(),
    status: () => ({ state: "online", childPid: 1, restartCount: 0, consecutiveFailures: 0, startedAt: 1, retainedCalls: session.snapshot().rows.length }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async stop() {},
  };
}
function forceGc() { try { Bun.gc(true); } catch {} }
async function fdCount(): Promise<number> { try { return (await readdir("/dev/fd")).length; } catch { return 0; } }
