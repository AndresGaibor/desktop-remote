# Background Daemon Core and Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight foreground daemon core that owns Desktop Commander, keeps canonical session state bounded, and automatically recovers the child process without loading any TUI code.

**Architecture:** Split canonical runtime state from TUI-only selection/filter state, bound telemetry before it enters long-lived memory, hard-limit upstream framing, and put `DesktopCommanderRuntime` behind a restart supervisor. This phase deliberately stops before IPC and `launchd`; it produces a daemon core that can be exercised directly and safely by tests.

**Tech Stack:** Bun, TypeScript, `bun:test`, Node-compatible child-process/stream APIs already used by the project.

**Spec:** `docs/superpowers/specs/2026-08-22-background-daemon-tui-design.md`

## Global Constraints

- Preserve the existing seven-file TUI stability fix in the current worktree; do not reset or discard it before execution.
- Before creating an isolated worktree, land that prior fix as its own verified commit or explicitly carry it into the worktree.
- Canonical history is limited to exactly 50 calls.
- Retained arguments are limited to 64 KiB, metadata to 32 KiB, result text to 256 KiB, and error text to 32 KiB per call.
- Upstream unterminated stdout/stderr remainder is limited to 2 MiB.
- Multiline tool-result parser accumulation is limited to 512 KiB and parser tracking is limited to 128 simultaneously active calls.
- Canonical auth/device/control strings are limited to 8 KiB each; runtime log/error messages forwarded for observability are limited to 64 KiB.
- Normal restart delays are 1s, 2s, 5s, 10s, 30s, then 60s maximum.
- A five-minute healthy child run resets restart backoff/failure count.
- Ten consecutive unstable failures enter degraded mode with five-minute retries.
- Daemon code must not import `@opentui/core`, `@opentui/solid`, `solid-js`, or anything under `src/tui`.
- Use TDD for every production behavior; run the focused failing test before implementation.

---
### Task 1: Canonical bounded runtime state

**Files:**
- Create: `src/session/bounds.ts`
- Create: `src/session/runtime-store.ts`
- Modify: `src/session/types.ts`
- Modify: `src/session/store.ts`
- Create: `test/session/runtime-store.test.ts`
- Modify: `test/session/store.test.ts`

**Interfaces:**
- Produce `SESSION_HISTORY_LIMIT = 50` and byte-limit constants in `src/session/bounds.ts`.
- Produce `boundUnknown(value, maxBytes): unknown`, `boundText(value, maxBytes): string`, and `boundRuntimeEvent(event): RuntimeEvent`.
- Produce `RuntimeSessionSnapshot` containing only `connection`, `device`, ephemeral `auth`, `rows`, and `counts`.
- Produce `RuntimeSessionStore.consume(event)`, `restore(snapshot)`, and `snapshot()`.
- Keep `SessionStore` as TUI presentation state; it consumes/replaces canonical runtime state while keeping query, filter, and selected-call state local.

- [ ] **Step 1: Write failing bounds/store tests**

```ts
const huge = "x".repeat(300 * 1024);
const store = new RuntimeSessionStore();
store.consume({ type: "tool.completed", callId: "c1", toolName: "read_file", resultText: huge, completedAt: 2 });
expect(Buffer.byteLength(store.snapshot().rows[0]!.resultText!)).toBeLessThanOrEqual(256 * 1024);
for (let i = 0; i < 75; i++) {
  store.consume({
    type: "tool.started",
    callId: `call-${i}`,
    toolName: "read_file",
    args: { path: `/tmp/${i}` },
    metadata: {},
    startedAt: i,
  });
}
expect(store.snapshot().rows).toHaveLength(50);
expect(store.snapshot().rows[0]!.callId).toBe("call-25");
```
Add a presentation-state regression proving `SessionStore.replaceRuntime()` preserves the current query/filter when a fresh runtime snapshot arrives.

- [ ] **Step 2: Run** `bun test test/session/runtime-store.test.ts test/session/store.test.ts` and confirm RED because the bounded canonical store does not exist yet.
- [ ] **Step 3: Implement the bounds helpers and canonical store**. Use UTF-8 byte counts (`Buffer.byteLength`), preserve useful head/tail text, and use a structured truncation marker such as:

```ts
export interface TruncatedValue {
  __desktopRemoteTruncated: true;
  originalBytes: number;
  preview: string;
}
```

`boundRuntimeEvent()` must bound `tool.started.args`, `tool.started.metadata`, `tool.completed.resultText`, and `tool.failed.error` before `RuntimeSessionStore` retains them.

- [ ] **Step 4: Refactor `SessionStore` to presentation-only state** by composing/replacing `RuntimeSessionSnapshot`; keep its existing `consume()` temporarily as a compatibility adapter that delegates to an internal `RuntimeSessionStore` until the IPC phase removes direct runtime ownership.
- [ ] **Step 5: Run** `bun test test/session/runtime-store.test.ts test/session/store.test.ts` and confirm GREEN.
- [ ] **Step 6: Run** `bun test test/tui/app.test.tsx test/tui/view-model.test.ts test/tui/activity-feed.test.tsx` to prove existing TUI behavior still accepts the refactored snapshot shape.
- [ ] **Step 7: Commit** only this task's session-state files with `git commit -m "refactor: split bounded runtime session state"`.

### Task 2: Hard-limit Desktop Commander stream framing and parser accumulation

**Files:**
- Modify: `src/runtime/desktop-commander-runtime.ts`
- Modify: `src/runtime/upstream-parser.ts`
- Modify: `test/runtime/desktop-commander-runtime.test.ts`
- Modify: `test/runtime/upstream-parser.test.ts`

**Interfaces:**
- Export `MAX_UPSTREAM_REMAINDER_BYTES = 2 * 1024 * 1024`, `MAX_PENDING_RESULT_BYTES = 512 * 1024`, and `MAX_ACTIVE_CALLS = 128`.
- Extend `ChildProcessLike` with optional `pid?: number` and expose `DesktopCommanderRuntime.pid` and `running` getters.
- `UpstreamParser` tracks pending multiline-result bytes incrementally instead of repeatedly joining an unbounded array; overflow emits one bounded `runtime.error`, clears that pending result, and returns to `normal`.
- Active-call tracking keeps at most 128 call IDs. When the 129th unfinished call arrives, evict the oldest tracked call from both the per-tool queue and `startedAtByCall`, emit one bounded `runtime.error`, then still emit the new `tool.started`; a later completion for the evicted call may intentionally fall back to the existing `unknown-<tool>-<timestamp>` ID.
- Add `UpstreamParser.activeCallCountForTest(): number` as an intentionally test-only method; do not export it through `src/index.ts`.
- Ensure child listeners and stdout/stderr remainder state are released when a child exits or `stop()` completes.
- [ ] **Step 1: Write the failing overflow and lifecycle tests**

```ts
child.stdout.write("x".repeat(MAX_UPSTREAM_REMAINDER_BYTES + 1024));
await Bun.sleep(0);
expect(events.some((event) => event.type === "runtime.error" && event.message.includes("2 MiB"))).toBe(true);
expect(runtime.running).toBe(true);
expect(runtime.pid).toBe(child.pid);
```

Add a restart-style test that closes the first fake child, starts a second runtime instance, and verifies the first streams no longer emit events into the runtime. Add parser tests that feed individually valid-size lines whose combined pending tool result exceeds 512 KiB and 129 unfinished tool starts; assert one overflow diagnostic, recovery on the next valid line, and `activeCallCountForTest()` never exceeds 128.

- [ ] **Step 2: Run** `bun test test/runtime/desktop-commander-runtime.test.ts test/runtime/upstream-parser.test.ts` and verify RED for missing limits/getters/cleanup/parser bounds.
- [ ] **Step 3: Implement bounded chunk handling** without concatenating an already-over-limit remainder. On overflow, emit one bounded `runtime.error`, clear the offending remainder, and continue parsing later newline-delimited data.
- [ ] **Step 4: Bound `UpstreamParser` internal state** with a byte counter for pending results and an insertion-order queue for active call IDs. Keep the test-only active-count accessor non-exported from the public package barrel. Never stringify/join the entire pending result merely to decide whether it is over the limit.
- [ ] **Step 5: Store named child event handlers** so teardown can remove listeners deterministically; clear `stdoutRemainder`, `stderrRemainder`, close promise state, and child reference exactly once.
- [ ] **Step 6: Run** `bun test test/runtime/desktop-commander-runtime.test.ts test/runtime/upstream-parser.test.ts` and confirm GREEN.
- [ ] **Step 7: Commit** `git add src/runtime/desktop-commander-runtime.ts src/runtime/upstream-parser.ts test/runtime/desktop-commander-runtime.test.ts test/runtime/upstream-parser.test.ts && git commit -m "fix: bound desktop commander runtime parsing"`.

### Task 3: Pure restart/backoff policy

**Files:**
- Create: `src/daemon/restart-policy.ts`
- Create: `test/daemon/restart-policy.test.ts`

**Interfaces:**

```ts
export interface RestartDecision { delayMs: number; degraded: boolean; consecutiveFailures: number }
export class RestartPolicy {
  nextAfterExit(runDurationMs: number): RestartDecision;
  reset(): void;
  snapshot(): { consecutiveFailures: number; degraded: boolean };
}
```
- [ ] **Step 1: Write failing policy tests** for the exact delay sequence and degradation threshold:

```ts
const policy = new RestartPolicy();
expect([0, 1, 2, 3, 4, 5].map(() => policy.nextAfterExit(1000).delayMs))
  .toEqual([1000, 2000, 5000, 10000, 30000, 60000]);
for (let i = 6; i < 10; i++) policy.nextAfterExit(1000);
expect(policy.snapshot()).toEqual({ consecutiveFailures: 10, degraded: true });
expect(policy.nextAfterExit(1000).delayMs).toBe(300000);
```

Add a test where `nextAfterExit(300000)` resets the sequence and the next unstable exit returns 1000 ms.

- [ ] **Step 2: Run** `bun test test/daemon/restart-policy.test.ts` and verify RED because `RestartPolicy` is missing.
- [ ] **Step 3: Implement the pure policy** with constants `HEALTHY_RESET_MS = 300000`, `DEGRADED_AFTER_FAILURES = 10`, `DEGRADED_RETRY_MS = 300000`, and the approved normal delay table.
- [ ] **Step 4: Run** `bun test test/daemon/restart-policy.test.ts` and confirm GREEN.
- [ ] **Step 5: Commit** `git add src/daemon/restart-policy.ts test/daemon/restart-policy.test.ts && git commit -m "feat: add bounded daemon restart policy"`.

### Task 4: Desktop Commander supervisor

**Files:**
- Create: `src/daemon/supervisor.ts`
- Create: `test/daemon/supervisor.test.ts`

**Interfaces:**

```ts
export type SupervisorState = "starting" | "auth" | "online" | "recovering" | "degraded" | "stopped";
export interface SupervisorStatus {
  state: SupervisorState;
  childPid?: number;
  restartCount: number;
  consecutiveFailures: number;
  startedAt: number;
  lastRestartAt?: number;
}
```
```ts
export interface ManagedRuntime {
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  start(): void;
  stop(): Promise<void>;
  readonly pid: number | undefined;
  readonly running: boolean;
}
export class DaemonSupervisor {
  start(): void;
  stop(): Promise<void>;
  status(): SupervisorStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  onStatus(listener: (status: SupervisorStatus) => void): () => void;
}
```

Inject `createRuntime`, `sleep(ms)`, and `now()` so every retry path is deterministic in tests. Desktop Commander 0.2.47 remains the network-health authority: its `RemoteChannel` already performs a 10-second connection health check plus bounded channel recreation/heartbeat logic. This supervisor must not duplicate that polling. It only restarts on terminal runtime exit/error conditions; sleep/wake and network recovery are validated later against the official watchdog, with a 60-second grace window before any manual fallback is considered.

- [ ] **Step 1: Write failing supervisor tests** using fake runtimes and a controlled sleep queue. Cover: first start creates one child, `auth.required`/`device.ready` update state, unexpected exit schedules exactly one replacement, stopping during backoff prevents replacement, and ten rapid failures use the five-minute degraded delay.
- [ ] **Step 2: Add the ownership invariant test**:

```ts
supervisor.start();
expect(factory.liveCount()).toBe(1);
first.emit(exited());
await sleeps.releaseNext();
expect(factory.maxLiveCount()).toBe(1);
```

- [ ] **Step 3: Run** `bun test test/daemon/supervisor.test.ts` and verify RED.
- [ ] **Step 4: Implement `DaemonSupervisor`**. Treat `runtime.exited` as the restart trigger, use a generation/cancellation token so stale sleeps cannot resurrect a stopped supervisor, unsubscribe the old runtime before replacement, and never call `start()` while another runtime is live.
- [ ] **Step 5: Run** `bun test test/daemon/supervisor.test.ts test/runtime/desktop-commander-runtime.test.ts` and confirm GREEN.
- [ ] **Step 6: Commit** `git add src/daemon/supervisor.ts test/daemon/supervisor.test.ts && git commit -m "feat: supervise desktop commander runtime"`.

### Task 5: Long-lived daemon core without TUI dependencies

**Files:**
- Create: `src/daemon/daemon.ts`
- Create: `src/daemon/run-daemon.ts`
- Create: `bin/daemon.ts`
- Create: `test/daemon/daemon.test.ts`
- Create: `test/daemon/architecture.test.ts`
- Modify: `package.json`
**Interfaces:**

```ts
export interface DaemonStatus extends SupervisorStatus { retainedCalls: number }
export class DesktopRemoteDaemon {
  start(): void;
  stop(): Promise<void>;
  snapshot(): RuntimeSessionSnapshot;
  status(): DaemonStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
```

`runDaemon()` wires a real `DesktopCommanderRuntime` factory to `DaemonSupervisor`, installs `SIGINT`/`SIGTERM` handlers, and performs one idempotent graceful shutdown. `bin/daemon.ts` is a development-only foreground entrypoint in this phase.

- [ ] **Step 1: Write failing daemon-core tests** proving supervisor events are bounded and retained in `RuntimeSessionStore`, `stop()` is idempotent, and a runtime restart does not clear the latest 50 calls.
- [ ] **Step 2: Write the failing architecture test**:

```ts
for await (const file of new Bun.Glob("src/daemon/**/*.{ts,tsx}").scan(".")) {
  const text = await Bun.file(file).text();
  expect(text).not.toMatch(/@opentui\/|solid-js|(?:^|\/)tui\//m);
}
```

- [ ] **Step 3: Run** `bun test test/daemon/daemon.test.ts test/daemon/architecture.test.ts` and verify RED.
- [ ] **Step 4: Implement `DesktopRemoteDaemon` and `runDaemon()`**. Runtime events flow `supervisor -> bound canonical store -> daemon listeners`; no TUI module participates.
- [ ] **Step 5: Add** `"daemon:dev": "bun run bin/daemon.ts"` to `package.json` and use it only for manual foreground smoke in this phase.
- [ ] **Step 6: Run** `bun test test/daemon test/session test/runtime && bun run typecheck` and confirm GREEN/exit 0.
- [ ] **Step 7: Start** `bun run daemon:dev` with a safe fake `--cmd` harness or test runtime; confirm idle foreground daemon stays alive after no UI is present, then stop it with `Ctrl+C` and confirm graceful child shutdown.
- [ ] **Step 8: Commit** `git add src/daemon bin/daemon.ts test/daemon package.json && git commit -m "feat: add long-lived desktop remote daemon core"`.

## Phase 1 final verification

Run from repository root:

```bash
bun test
bun run typecheck
git diff --check
rg -n '@opentui/|solid-js|src/tui|\.\./tui' src/daemon
```

Expected: full suite passes, TypeScript exits 0, diff check is clean, and the architecture scan produces no matches. This phase is complete only when the daemon owns at most one child across repeated failure/restart tests and canonical retained state remains bounded to 50 calls with the approved byte limits.
