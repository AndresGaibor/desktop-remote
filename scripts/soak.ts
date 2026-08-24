import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonIpcServer, type IpcDaemonSource } from "../src/daemon/ipc-server";
import { HistoryStore, HISTORY_MAX_BYTES } from "../src/daemon/history-store";
import { RotatingDaemonLog, LOG_FILE_COUNT, LOG_FILE_MAX_BYTES } from "../src/logging/rotating-log";
import { DesktopRemoteIpcClient } from "../src/client/ipc-client";
import { RuntimeSessionStore } from "../src/session/runtime-store";
import { makePaths } from "./soak-paths";
import type { RuntimeEvent } from "../src/runtime/events";

const TOTAL_EVENTS = 1_000_000;
const WARMUP_EVENTS = 100_000;
const SAMPLE_EVERY = 100_000;
const ATTACH_CYCLES = 1_000;

const dir = await mkdtemp(join(tmpdir(), "desktop-remote-soak-"));
const paths = makePaths(dir);
const store = new RuntimeSessionStore();
const rssSamples: number[] = [];

for (let index = 0; index < TOTAL_EVENTS; index += 1) {
  const id = `call-${index}`;
  store.consume({ type: "tool.started", callId: id, toolName: "read_file", args: { path: `/tmp/${index}` }, metadata: {}, startedAt: index });
  store.consume({ type: "tool.completed", callId: id, toolName: "read_file", resultText: "ok", completedAt: index + 1 });
  if ((index + 1) >= WARMUP_EVENTS && (index + 1) % SAMPLE_EVERY === 0) {
    forceGc();
    rssSamples.push(process.memoryUsage().rss);
  }
  if (store.snapshot().rows.length > 50) throw new Error("retained calls exceeded 50");
}

const warmRss = rssSamples[0] ?? process.memoryUsage().rss;
forceGc();
const endRss = process.memoryUsage().rss;
const allowedGrowth = Math.max(64 * 1024 * 1024, Math.floor(warmRss * 0.25));
if (endRss - warmRss > allowedGrowth) throw new Error(`RSS growth exceeded limit: ${endRss - warmRss} > ${allowedGrowth}`);

const history = new HistoryStore({ path: paths.historyPath });
await history.compact(store.snapshot());
if (await history.sizeBytes() > HISTORY_MAX_BYTES) throw new Error("history exceeded hard ceiling");

const log = new RotatingDaemonLog({ path: join(paths.logsDir, "daemon.log") });
for (let index = 0; index < 8_000; index += 1) await log.warn("soak warning", { index, detail: "x".repeat(1024) });
const logBytes = await log.totalSizeBytes();
if (logBytes > LOG_FILE_COUNT * LOG_FILE_MAX_BYTES) throw new Error("logs exceeded total ceiling");

const source = makeSource(store);
const ipc = new DaemonIpcServer({ source, paths, leaseTimeoutMs: 90_000 });
const fdBefore = await fdCount();
await ipc.start();
for (let index = 0; index < ATTACH_CYCLES; index += 1) {
  const client = new DesktopRemoteIpcClient({ socketPath: paths.socketPath, requestTimeoutMs: 2_000 });
  await client.connect("visual");
  await client.requestSnapshot();
  await client.close();
  if (index % 25 === 0) await Bun.sleep(1);
}
await ipc.stop();
await Bun.sleep(10);
forceGc();
const fdAfter = await fdCount();
if (fdAfter - fdBefore > 4) throw new Error(`FD growth exceeded limit: ${fdAfter - fdBefore}`);

console.log(JSON.stringify({
  events: TOTAL_EVENTS,
  attachCycles: ATTACH_CYCLES,
  retainedCalls: store.snapshot().rows.length,
  warmRss,
  endRss,
  rssGrowth: endRss - warmRss,
  allowedGrowth,
  fdBefore,
  fdAfter,
  historyBytes: await history.sizeBytes(),
  logBytes,
}, null, 2));

function makeSource(session: RuntimeSessionStore): IpcDaemonSource {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    snapshot: () => session.snapshot(),
    status: () => ({ state: "online", childPid: 1, restartCount: 0, consecutiveFailures: 0, startedAt: 1, retainedCalls: session.snapshot().rows.length }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async stop() {},
    async execute() { return undefined; },
  };
}
function forceGc() { try { Bun.gc(true); } catch {} }
async function fdCount(): Promise<number> { try { return (await readdir("/dev/fd")).length; } catch { return 0; } }
