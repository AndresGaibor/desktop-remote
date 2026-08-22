# Unix IPC and Optional TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the TUI into a disposable Unix-socket client of the daemon, with one exclusive visual lease, bounded snapshot/event streaming, and automatic reattachment after daemon restarts.

**Architecture:** Add a small versioned newline-delimited JSON protocol, a bounded Unix-socket server owned by the daemon, and a reconnecting client/session source that updates the existing TUI presentation store. Refactor `runTui` so closing the renderer only closes the client connection and never stops Desktop Commander.

**Tech Stack:** Bun, TypeScript, `bun:test`, Unix domain sockets via Bun/Node-compatible `net`, SolidJS/OpenTUI only in the client/TUI process.

**Spec:** `docs/superpowers/specs/2026-08-22-background-daemon-tui-design.md`

## Global Constraints

- Requires completion of `docs/superpowers/plans/2026-08-22-daemon-core-supervision.md`.
- IPC protocol version is exactly `1` initially.
- Maximum IPC frame size is 512 KiB.
- Initial snapshots are streamed as begin + at most 50 call frames + end; never one giant snapshot frame.
- A single exclusive visual lease is allowed; admin/status clients do not consume that lease.
- Socket EOF releases the visual lease immediately.
- Attached-client heartbeat interval is 30 seconds; three missed windows release a pathological stale lease.
- TUI reconnect delays are 1s, 2s, 5s, 10s, then 30s maximum.
- Default socket path is `~/Library/Caches/desktop-remote/daemon.sock` and its containing directory is mode `0700`.
- Live auth URL/code may cross IPC but must never be persisted or daemon-logged.
- No polling loop for session updates; snapshots are initial synchronization and later changes are incremental events.
- Use TDD for every protocol/lifecycle behavior.

---
### Task 1: Versioned bounded IPC protocol and framer

**Files:**
- Create: `src/ipc/protocol.ts`
- Create: `src/ipc/framing.ts`
- Create: `test/ipc/protocol.test.ts`
- Create: `test/ipc/framing.test.ts`

**Interfaces:**

```ts
export const PROTOCOL_VERSION = 1;
export const MAX_IPC_FRAME_BYTES = 512 * 1024;
type Versioned = { protocolVersion: 1 };
export type ClientMessage =
  | (Versioned & { type: "hello"; client: "visual" | "admin" })
  | (Versioned & { type: "attach" })
  | (Versioned & { type: "snapshot.request" })
  | (Versioned & { type: "subscribe" })
  | (Versioned & { type: "status.request"; requestId: string })
  | (Versioned & { type: "ping"; at: number })
  | (Versioned & { type: "detach" })
  | (Versioned & { type: "shutdown" });
export type ServerMessage =
  | (Versioned & { type: "hello.ack"; daemonPid: number })
  | (Versioned & { type: "snapshot.begin"; connection: ConnectionStatus; device?: SessionDevice; auth?: SessionAuth; counts: SessionCounts; callCount: number })
  | (Versioned & { type: "snapshot.call"; row: ToolCallRow })
  | (Versioned & { type: "snapshot.end" })
  | (Versioned & { type: "event"; event: RuntimeEvent })
  | (Versioned & { type: "status"; requestId: string; status: DaemonStatus })
  | (Versioned & { type: "pong"; at: number })
  | (Versioned & { type: "already-attached"; attachedSince: number })
  | (Versioned & { type: "error"; code: string; message: string });
export function parseClientMessage(value: unknown): ClientMessage;
export function parseServerMessage(value: unknown): ServerMessage;
export function encodeFrame(message: ClientMessage | ServerMessage): string;
export class JsonLineDecoder<T = unknown> { push(chunk: Buffer | string): T[]; end(): T[]; }
```

- [ ] **Step 1: Write failing protocol tests** that assert `protocolVersion: 1`, reject unknown message types, and reject client/server messages with the wrong protocol version.
- [ ] **Step 2: Write failing framer tests**:

```ts
const decoder = new JsonLineDecoder();
expect(decoder.push('{"type":"ping"')).toEqual([]);
expect(decoder.push(',"protocolVersion":1}\n')).toHaveLength(1);
expect(() => decoder.push("x".repeat(MAX_IPC_FRAME_BYTES + 1))).toThrow(/512 KiB/);
```

- [ ] **Step 3: Run** `bun test test/ipc/protocol.test.ts test/ipc/framing.test.ts` and verify RED.
- [ ] **Step 4: Implement discriminated protocol guards and bounded framing**. Count UTF-8 bytes before retaining/decoding a frame; reset the decoder buffer after an oversized frame error.
- [ ] **Step 5: Run** the focused IPC tests and confirm GREEN.
- [ ] **Step 6: Commit** `git add src/ipc test/ipc && git commit -m "feat: define bounded daemon ipc protocol"`.
### Task 2: Secure Unix-socket daemon server and exclusive lease

**Files:**
- Create: `src/platform/paths.ts`
- Create: `src/daemon/ipc-server.ts`
- Create: `test/daemon/ipc-server.test.ts`
- Create: `test/platform/paths.test.ts`
- Modify: `src/daemon/daemon.ts`

**Interfaces:**

```ts
export interface DesktopRemotePaths { appSupportDir: string; cacheDir: string; socketPath: string; }
export function getDesktopRemotePaths(homeDir?: string): DesktopRemotePaths;
export interface IpcDaemonSource {
  snapshot(): RuntimeSessionSnapshot;
  status(): DaemonStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  stop(): Promise<void>;
}
export class DaemonIpcServer { start(): Promise<void>; stop(): Promise<void>; }
```

- [ ] **Step 1: Write failing path/security tests** using a temporary home. Assert cache directory creation mode `0700` and socket path `<home>/Library/Caches/desktop-remote/daemon.sock` on macOS.
- [ ] **Step 2: Write failing server integration tests** with real local sockets. First client sends `hello + attach` and receives `hello.ack`; second visual attach receives `already-attached`, while a third admin client can still request `status`.
- [ ] **Step 3: Add snapshot streaming assertions**:

```ts
client.write(frame({ type: "snapshot.request", protocolVersion: 1 }));
expect(types(received)).toEqual(["snapshot.begin", ...Array(50).fill("snapshot.call"), "snapshot.end"]);
expect(received.every((message) => Buffer.byteLength(JSON.stringify(message)) <= MAX_IPC_FRAME_BYTES)).toBe(true);
```

- [ ] **Step 4: Add stale-socket safety tests**. A symlink at the socket path must cause startup failure. An owned stale Unix socket entry that cannot be connected to may be removed. A live socket must never be unlinked by a second daemon attempt.
- [ ] **Step 5: Run** `bun test test/daemon/ipc-server.test.ts test/platform/paths.test.ts` and verify RED.
- [ ] **Step 6: Implement the server**. Bind only after ownership/type checks, chmod the socket to user-only access, hold one visual lease keyed by the attached socket, release it on EOF/error/detach, and allow admin-only status requests independently.
- [ ] **Step 7: Add the low-frequency lease expiry**. Update `lastHeartbeatAt` when the attached client sends `ping`; close/release only after 90 seconds without heartbeat. Use one rescheduled timeout rather than a fast interval.
- [ ] **Step 8: Wire daemon events into the server**. Send bounded `event` frames only to the subscribed visual client. `auth.required` can be delivered live, but do not pass it to any persistence/logging API introduced later.
- [ ] **Step 9: Run** `bun test test/daemon/ipc-server.test.ts test/ipc test/platform/paths.test.ts` and confirm GREEN.
- [ ] **Step 10: Commit** `git add src/platform/paths.ts src/daemon/ipc-server.ts src/daemon/daemon.ts test/daemon/ipc-server.test.ts test/platform/paths.test.ts && git commit -m "feat: expose daemon over local unix socket"`.

### Task 3: Reconnecting IPC client and TUI session source

**Files:**
- Create: `src/client/ipc-client.ts`
- Create: `src/client/session-source.ts`
- Create: `test/client/ipc-client.test.ts`
- Create: `test/client/session-source.test.ts`

**Interfaces:**

```ts
export type ClientConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "stopped";
export class DesktopRemoteIpcClient {
  connect(mode: "visual" | "admin"): Promise<void>;
  requestStatus(): Promise<DaemonStatus>;
  requestSnapshot(): Promise<RuntimeSessionSnapshot>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
}
export interface TuiSessionSource {
  start(onChange: () => void): Promise<void>;
  stop(): Promise<void>;
  connectionState(): ClientConnectionState;
}
export class IpcTuiSessionSource implements TuiSessionSource {}
```
- [ ] **Step 1: Write failing client tests** against a real test socket. Verify visual attach handshake, status request/response correlation, snapshot assembly from `snapshot.begin/call/end`, event subscription, and a typed `AlreadyAttachedError` for `already-attached`.
- [ ] **Step 2: Add heartbeat tests** with an injected scheduler. Once connected visually, exactly one `ping` is sent every 30 seconds; `close()` cancels the scheduled heartbeat and closes the socket.
- [ ] **Step 3: Write failing session-source tests**. Feed an initial 50-call snapshot, then one incremental `tool.completed` event; assert `SessionStore` receives the snapshot/event while its local query/filter selection state remains local.
- [ ] **Step 4: Add deterministic reconnect tests** with injected `connectClient` and `sleep`:

```ts
expect(retryDelaysAfterFiveDisconnects()).toEqual([1000, 2000, 5000, 10000, 30000]);
source.stop();
await releasePendingSleep();
expect(connectAttempts).toBe(attemptsBeforeStop);
```

A successful reconnect must reacquire the visual lease, request a fresh snapshot, then resume incremental subscription; it must not replay stale client-side events over the fresh snapshot.

- [ ] **Step 5: Run** `bun test test/client/ipc-client.test.ts test/client/session-source.test.ts` and verify RED.
- [ ] **Step 6: Implement `DesktopRemoteIpcClient`** with one decoder per socket, bounded message validation, request promises with timeouts, clean rejection on socket close, and no unbounded received-message queue.
- [ ] **Step 7: Implement `IpcTuiSessionSource`**. Set states `connecting -> connected -> reconnecting`, use the exact retry table with 30s cap, cancel retries on `stop()`, and call `SessionStore.replaceRuntime()` after each complete snapshot.
- [ ] **Step 8: Run** the focused client/source tests plus `bun test test/session` and confirm GREEN.
- [ ] **Step 9: Commit** `git add src/client test/client && git commit -m "feat: add reconnecting daemon ipc client"`.

### Task 4: Decouple OpenTUI lifecycle from Desktop Commander lifecycle

**Files:**
- Modify: `src/tui/run-tui.tsx`
- Modify: `src/tui/app.tsx`
- Modify: `test/tui/run-tui.test.ts`
- Modify: `test/tui/app.test.tsx`

**Interfaces:**
- Remove `TuiSessionBridge` as owner of `RuntimeController`.
- `runTui()` accepts a `SessionStore` and a `TuiSessionSource`; it never receives or stops `DesktopCommanderRuntime`.
- TUI `Ctrl+C`/quit calls `source.stop()` and destroys the renderer only.
- The app displays a lightweight reconnecting indicator from `source.connectionState()` without rebuilding historical rows.
- [ ] **Step 1: Replace the old bridge tests with failing source-lifecycle tests**:

```ts
const source = new FakeSessionSource();
await runTuiForTest({ store, source, renderer });
expect(source.starts).toBe(1);
await triggerQuit();
expect(source.stops).toBe(1);
expect(fakeDesktopCommanderStops).toBe(0);
```

Add an app render test that changes source state from `connected` to `reconnecting` while rows remain visible and asserts the frame contains `reconnecting` plus the existing latest call.

- [ ] **Step 2: Run** `bun test test/tui/run-tui.test.ts test/tui/app.test.tsx` and verify RED because `runTui` still owns a runtime bridge.
- [ ] **Step 3: Refactor `runTui()`** to start/stop only `TuiSessionSource`; keep renderer destruction idempotent. Remove `TuiSessionBridge`, `RuntimeController`, and `EventLogWriter` from the TUI module.
- [ ] **Step 4: Thread connection state into `DesktopRemoteApp`** without moving query/filter/selection into the daemon. Do not add a render timer; source state changes must trigger the same explicit refresh callback used by snapshot/event changes.
- [ ] **Step 5: Run** all TUI tests, including the existing 250-refresh TextBufferView stress regression, and confirm GREEN.
- [ ] **Step 6: Commit** `git add src/tui test/tui && git commit -m "refactor: make tui a disposable session client"`.

### Task 5: End-to-end daemon/client lifecycle without production launchd

**Files:**
- Modify: `src/daemon/run-daemon.ts`
- Create: `bin/attach.ts`
- Create: `test/integration/daemon-client-lifecycle.test.ts`
- Modify: `package.json`

**Interfaces:**
- `runDaemon()` starts `DesktopRemoteDaemon` plus `DaemonIpcServer` and shuts both down in the order: stop accepting IPC -> close clients -> stop supervisor/child -> remove owned socket.
- `bin/attach.ts` is a development entrypoint that creates `SessionStore + DesktopRemoteIpcClient + IpcTuiSessionSource`, dynamically imports `runTui`, and attaches to an already-running daemon.
- Add scripts `daemon:dev` and `attach:dev`; production CLI lifecycle commands are deferred to the macOS/install phase.

- [ ] **Step 1: Write the failing lifecycle integration test** with a fake `ManagedRuntime`, real `DaemonIpcServer`, and real client. Attach client A, verify client B gets `AlreadyAttachedError`, close A, attach B, and assert the same fake runtime instance is still running throughout.
- [ ] **Step 2: Extend the lifecycle test to simulate a TUI crash** by destroying A's socket without `detach`; wait for EOF processing, attach B, and assert daemon status still reports the same child PID/restart count.
- [ ] **Step 3: Add a daemon-restart/client-reconnect test**. Stop only the first IPC server while keeping the test process/source alive, start a replacement server on the same socket, release the source's controlled retry sleep, and assert it reacquires the lease and receives a fresh snapshot.
- [ ] **Step 4: Run** `bun test test/integration/daemon-client-lifecycle.test.ts` and verify RED before wiring the combined daemon/server lifecycle.
- [ ] **Step 5: Implement combined startup/shutdown** in `runDaemon()` and the development `bin/attach.ts`. The attach entrypoint must dynamically import `../src/tui/run-tui` only after IPC attach succeeds.
- [ ] **Step 6: Add** `"attach:dev": "bun run bin/attach.ts"` to `package.json`; keep `daemon:dev` as the foreground daemon process.
- [ ] **Step 7: Run** `bun test test/integration/daemon-client-lifecycle.test.ts test/client test/daemon test/tui && bun run typecheck` and confirm GREEN/exit 0.
- [ ] **Step 8: Run the architecture scans**:

```bash
rg -n '@opentui/|solid-js|src/tui|\.\./tui' src/daemon src/runtime src/session
rg -n 'DesktopCommanderRuntime|desktop-commander' src/tui
```

Expected: both scans produce no matches. The first scan may reference no TUI libraries outside client/TUI; the second proves the renderer cannot directly own the official runtime anymore.

- [ ] **Step 9: Manual development smoke** in two terminals: run `bun run daemon:dev`, then `bun run attach:dev`; close the TUI with `Ctrl+C`, confirm daemon remains running, attach again, and confirm the same retained calls are visible.
- [ ] **Step 10: Commit** `git add src/daemon/run-daemon.ts bin/attach.ts test/integration/daemon-client-lifecycle.test.ts package.json && git commit -m "feat: attach optional tui to background daemon"`.

## Phase 2 final verification

Run from repository root:

```bash
bun test
bun run typecheck
git diff --check
rg -n '@opentui/|solid-js|src/tui|\.\./tui' src/daemon src/runtime src/session
rg -n 'DesktopCommanderRuntime|desktop-commander' src/tui
```

Expected: full suite passes, TypeScript exits 0, diff check is clean, architecture scans return no matches, one visual attach is enforced, TUI socket loss frees its lease, and killing/closing a TUI never calls daemon or Desktop Commander shutdown.
