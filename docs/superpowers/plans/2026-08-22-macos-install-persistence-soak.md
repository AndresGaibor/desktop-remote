# macOS Installation, Persistence, and Long-Run Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon production-ready on macOS with bounded durable history/logging, persistent start/stop semantics, `launchd` auto-recovery, compiled installation, operational commands, and soak/fault-injection release gates.

**Architecture:** Persist only bounded canonical state and quiet rotating diagnostics under user-owned Application Support, manage desired state independently, install a user LaunchAgent with absolute runtime paths, and keep the TUI/CLI separate from the long-lived daemon. Build/install probes determine whether one compiled artifact is safe; the implementation automatically falls back to split daemon + CLI artifacts when OpenTUI/native loading contaminates the daemon process.

**Tech Stack:** Bun/TypeScript, `bun:test`, macOS `launchctl`, user LaunchAgents, filesystem atomic rename/fsync, exact `@wonderwhy-er/desktop-commander` 0.2.47 runtime provisioning.

**Spec:** `docs/superpowers/specs/2026-08-22-background-daemon-tui-design.md`

## Global Constraints

- Requires completion of the daemon-core and IPC/TUI plans dated 2026-08-22.
- Production runs as the current user; never use root, `sudo`, or a system LaunchDaemon.
- LaunchAgent label is `com.desktop-remote.daemon` with `RunAtLoad=true`, `KeepAlive=true`, and `ThrottleInterval=10`.
- Intentional `stop` persists until explicit `start`; the default `desktop-remote` command must not override desired state `stopped`.
- Missing desired-state file initializes to `running`; only literal `running` and `stopped` are valid values.
- Persisted history is at most 50 calls and has a hard 24 MiB file ceiling.
- Daemon logs are at most three files of 2 MiB each, about 6 MiB total.
- Application-support/cache directories are mode `0700`; desired-state/history/runtime metadata/log files are mode `0600`.
- History/auth persistence must never write the live auth URL/code.
- `desktop-remote`/LaunchAgent must use absolute runtime paths, not an interactive shell PATH.
- Production provisions the official Desktop Commander package at exact version `0.2.47` in a stable runtime directory.
- Accelerated soak drives up to 1,000,000 simulated events; release soak defaults to 30 minutes.
- Use TDD and fault injection; never test `launchd` lifecycle by killing the currently active Remote Desktop Commander connection until the new service is otherwise verified.

---
### Task 1: Atomic desired state and production path model

**Files:**
- Modify: `src/platform/paths.ts`
- Create: `src/platform/atomic-file.ts`
- Create: `src/platform/desired-state.ts`
- Modify: `test/platform/paths.test.ts`
- Create: `test/platform/desired-state.test.ts`

**Interfaces:**

```ts
export type DesiredState = "running" | "stopped";
export interface DesktopRemotePaths {
  appSupportDir: string; cacheDir: string; binDir: string; runtimeDir: string;
  logsDir: string; socketPath: string; desiredStatePath: string;
  historyPath: string; runtimeMetadataPath: string; launchAgentPath: string;
}
export async function writeAtomicJson(path: string, value: unknown, mode?: number): Promise<void>;
export async function readDesiredState(path: string): Promise<DesiredState>;
export async function writeDesiredState(path: string, state: DesiredState): Promise<void>;
```

- [ ] **Step 1: Write failing path tests** for exact macOS locations under a temporary home, including `~/Library/Application Support/desktop-remote` and `~/Library/LaunchAgents/com.desktop-remote.daemon.plist`.
- [ ] **Step 2: Write failing desired-state tests**. Missing file returns `running`; valid values round-trip; malformed JSON or any value other than `running|stopped` throws and does not silently reset to running.
- [ ] **Step 3: Add atomic-write failure tests** by injecting/monkeypatching rename so the original valid desired-state file remains intact when replacement fails.
- [ ] **Step 4: Run** `bun test test/platform/paths.test.ts test/platform/desired-state.test.ts` and verify RED.
- [ ] **Step 5: Implement atomic writes** using same-directory temporary files, explicit file mode, `FileHandle.sync()`, close, then `rename()`. Ensure parent directories are user-only before creating sensitive files.
- [ ] **Step 6: Implement strict desired-state parsing** and initialize a missing file to `running` only when install/start first needs to persist it.
- [ ] **Step 7: Run** focused platform tests and confirm GREEN.
- [ ] **Step 8: Commit** `git add src/platform test/platform && git commit -m "feat: persist desktop remote desired state"`.

### Task 2: Bounded durable session history

**Files:**
- Create: `src/daemon/history-store.ts`
- Create: `test/daemon/history-store.test.ts`
- Modify: `src/daemon/daemon.ts`

**Interfaces:**

```ts
export const STATE_VERSION = 1;
export const HISTORY_MAX_BYTES = 24 * 1024 * 1024;
export type PersistedRuntimeSnapshot = Omit<RuntimeSessionSnapshot, "auth">;
export type HistoryRecord =
  | { stateVersion: 1; kind: "checkpoint"; snapshot: PersistedRuntimeSnapshot }
  | { stateVersion: 1; kind: "event"; event: RuntimeEvent };
export class HistoryStore {
  loadInto(store: RuntimeSessionStore): Promise<void>;
  append(event: RuntimeEvent, snapshot: RuntimeSessionSnapshot): Promise<void>;
  compact(snapshot: RuntimeSessionSnapshot): Promise<void>;
  sizeBytes(): Promise<number>;
}
```

`PersistedRuntimeSnapshot` omits ephemeral `auth`. `HistoryStore.append()` must skip `auth.required` entirely; a restart can return to `starting/auth` based on fresh upstream events rather than persisting verification secrets.

- [ ] **Step 1: Write failing persistence tests**: append 75 calls, compact/reload, and assert exactly the latest 50 rows survive with their bounded args/results/status.
- [ ] **Step 2: Add a secret test** where an `auth.required` URL/code is processed by the daemon, then assert neither string appears in `history.jsonl`.
- [ ] **Step 3: Add file-bound/compaction tests**. Use `HISTORY_COMPACT_AT_BYTES = 20 * 1024 * 1024`; feed bounded near-limit events until compaction occurs and assert `stat.size <= HISTORY_MAX_BYTES` after every append.
- [ ] **Step 4: Add corruption tests**. A malformed trailing line or unsupported `stateVersion` must not abort daemon startup; `loadInto()` keeps only state reconstructed from preceding valid records, reports one warning callback, and stops reading the corrupt suffix.
- [ ] **Step 5: Run** `bun test test/daemon/history-store.test.ts` and verify RED.
- [ ] **Step 6: Implement streaming load** with `createReadStream` + `readline`, never `Bun.file(path).text()` for daemon history. Compaction writes one bounded checkpoint through `writeAtomicJson`-style temp/fsync/rename semantics; incremental records append only after canonical bounding/redaction.
- [ ] **Step 7: Wire `DesktopRemoteDaemon`** to load history before supervisor start and append non-auth runtime events after canonical state mutation. Persistence failures become bounded warnings and must not crash the active remote connection.
- [ ] **Step 8: Run** `bun test test/daemon/history-store.test.ts test/daemon/daemon.test.ts && bun run typecheck` and confirm GREEN/exit 0.
- [ ] **Step 9: Commit** `git add src/daemon/history-store.ts src/daemon/daemon.ts test/daemon/history-store.test.ts && git commit -m "feat: persist bounded daemon session history"`.

### Task 3: Quiet rotating daemon logs

**Files:**
- Create: `src/logging/rotating-log.ts`
- Create: `test/logging/rotating-log.test.ts`
- Modify: `src/logging/redactor.ts`
- Modify: `src/daemon/daemon.ts`

**Interfaces:**

```ts
export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_FILE_COUNT = 3;
export class RotatingDaemonLog {
  info(message: string, data?: unknown): Promise<void>;
  warn(message: string, data?: unknown): Promise<void>;
  error(message: string, data?: unknown): Promise<void>;
  totalSizeBytes(): Promise<number>;
}
export function redactText(value: string): string;
```
- [ ] **Step 1: Write failing redaction/log tests**. Include Bearer tokens, `ABCD-EFGH` verification codes, nested `password`, and an auth URL query value; assert sensitive material does not appear in any rotated file.
- [ ] **Step 2: Write rotation tests** using a tiny injected `maxBytes` so enough warning entries produce exactly `daemon.log`, `daemon.log.1`, and `daemon.log.2`, with no `.3` and a bounded total size.
- [ ] **Step 3: Run** `bun test test/logging/rotating-log.test.ts test/logging/jsonl.test.ts` and verify RED.
- [ ] **Step 4: Export/reuse `redactText()`** from the existing redactor instead of maintaining a second secret regex set. Write each log entry as one bounded JSON line with timestamp, level, message, and redacted structured data.
- [ ] **Step 5: Implement rotation before append** using rename order `.1 -> .2`, current -> `.1`, then reopen current; chmod created files `0600`. Serialize writes through one promise chain so concurrent warnings cannot interleave/over-rotate.
- [ ] **Step 6: Wire only operational events**: daemon start/stop, auth-required without URL/code, supervisor state/restarts, persistence warnings, IPC warnings, and runtime errors. Do not log every tool call, heartbeat, or raw runtime line.
- [ ] **Step 7: Run** `bun test test/logging test/daemon/daemon.test.ts && bun run typecheck` and confirm GREEN.
- [ ] **Step 8: Commit** `git add src/logging src/daemon/daemon.ts test/logging && git commit -m "feat: add bounded rotating daemon logs"`.

### Task 4: Runtime provisioning and LaunchAgent lifecycle

**Files:**
- Create: `src/platform/command-runner.ts`
- Create: `src/platform/runtime-install.ts`
- Create: `src/platform/launchd.ts`
- Create: `test/platform/runtime-install.test.ts`
- Create: `test/platform/launchd.test.ts`

**Interfaces:**

```ts
export interface RuntimeMetadata { version: 1; nodePath: string; desktopCommanderEntry: string; desktopCommanderVersion: "0.2.47"; }
export interface CommandResult { exitCode: number; stdout: string; stderr: string; }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
export interface LaunchdStatus { loaded: boolean; enabled: boolean; pid?: number; lastExitCode?: number; }
export async function provisionDesktopCommander(paths: DesktopRemotePaths, run: CommandRunner): Promise<RuntimeMetadata>;
export class LaunchdManager { install(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; status(): Promise<LaunchdStatus>; }
```
- [ ] **Step 1: Write failing runtime-provisioning tests** with injected executable resolution/command runner. Assert the generated runtime package manifest pins only `@wonderwhy-er/desktop-commander: "0.2.47"`, `bun install --production` targets the stable runtime directory, Node version validation rejects `<18`, and metadata stores absolute paths.
- [ ] **Step 2: Write failing LaunchAgent plist tests**. Assert label `com.desktop-remote.daemon`, exact installed daemon `ProgramArguments`, `RunAtLoad=true`, `KeepAlive=true`, and integer `ThrottleInterval=10`. Do not create unbounded `StandardOutPath`/`StandardErrorPath` files; daemon logging owns bounded files.
- [ ] **Step 3: Write failing command-sequence tests** for low-level launchd operations using a fake runner: `bootstrap gui/<uid> <plist>`, `enable gui/<uid>/com.desktop-remote.daemon`, `kickstart -k ...`, `disable ...`, and `bootout ...`.
- [ ] **Step 4: Run** `bun test test/platform/runtime-install.test.ts test/platform/launchd.test.ts` and verify RED.
- [ ] **Step 5: Implement runtime provisioning**. Resolve absolute `bun` and `node`, validate Node >=18, create a minimal runtime package, install production dependencies into `runtimeDir`, verify the installed package reports exactly `0.2.47`, resolve `dist/index.js`, and atomically write `runtime.json` mode `0600`.
- [ ] **Step 6: Implement low-level `LaunchdManager`** with no shell-string execution; pass command and args arrays to the runner. Treat already-bootstrapped/not-bootstrapped launchctl responses idempotently where documented by tests.
- [ ] **Step 7: Run** focused platform tests and `bun run typecheck`; confirm GREEN/exit 0.
- [ ] **Step 8: Commit** `git add src/platform test/platform && git commit -m "feat: provision runtime and manage launchagent"`.

### Task 5: Production build, service controller, and CLI commands

**Files:**
- Create: `src/platform/service-controller.ts`
- Create: `src/cli/main.ts`
- Create: `scripts/build-production.ts`
- Modify: `bin/cli.ts`
- Modify: `bin/daemon.ts`
- Modify: `src/daemon/run-daemon.ts`
- Modify: `src/launcher.ts`
- Modify: `package.json`
- Create: `test/platform/service-controller.test.ts`
- Create: `test/cli-main.test.ts`
- Create: `test/build/production-build.test.ts`

**Interfaces:**

```ts
export class ServiceController {
  install(): Promise<void>; start(): Promise<void>; stop(): Promise<void>;
  restart(): Promise<void>; ensureRunning(): Promise<void>; status(): Promise<DaemonStatus | LaunchdStatus>;
}
export async function runCli(argv: string[]): Promise<number>;
```
- [ ] **Step 1: Write failing service-controller tests** for exact intentional-stop ordering: write `stopped` first, disable launchd, request IPC shutdown when reachable, wait for daemon exit, then bootout any leftover job. `start()` writes `running`, enables/bootstrap-loads, kickstarts, waits for socket, and requires a healthy status response.
- [ ] **Step 2: Add default-command tests**. With desired state `stopped`, `runCli([])` exits nonzero with `Desktop Remote is intentionally stopped. Run: desktop-remote start` and performs no launchd action. With `running` and no socket, it calls `ensureRunning()` then attaches.
- [ ] **Step 3: Add command parsing tests** for `start`, `attach`, `status`, `restart`, `stop`, `logs`, `logs --follow`, `install`, hidden `daemon`, existing `replay`, and legacy non-TTY pipe mode. Explicit admin commands must work even when stdin is not a TTY.
- [ ] **Step 4: Write the failing daemon-runtime test** proving installed `runtime.json` produces this child invocation:

```ts
expect(spawn).toEqual({
  command: metadata.nodePath,
  args: [metadata.desktopCommanderEntry, "remote", "--persist-session"],
});
```

The daemon reads desired state before opening the socket/child and exits immediately when it is `stopped`.

- [ ] **Step 5: Write failing production-build tests**. `build-production.ts` first compiles a single candidate from `bin/cli.ts`, runs `candidate daemon --probe` on macOS with `DYLD_PRINT_LIBRARIES=1`, and accepts it only when compile/probe exits 0 and stderr does not contain `libopentui`/`@opentui` native loading.
- [ ] **Step 6: Define the automatic split fallback**. If the single candidate fails that probe, compile `bin/cli.ts -> dist/desktop-remote` and `bin/daemon.ts -> dist/desktop-remote-daemon`, probe the daemon artifact the same way, and write `dist/build-layout.json` with `{"layout":"split","daemon":"desktop-remote-daemon","cli":"desktop-remote"}`. A clean single build writes layout `single` and daemon command `desktop-remote daemon`.
- [ ] **Step 7: Run** `bun test test/platform/service-controller.test.ts test/cli-main.test.ts test/build/production-build.test.ts` and verify RED.
- [ ] **Step 8: Implement `ServiceController` and CLI orchestration**. `install()` provisions runtime, builds/probes artifacts, copies each artifact as `.new`, verifies executable smoke, renames current to `.previous`, atomically promotes `.new`, writes/updates the plist, then starts and health-checks the service. If new-service health fails, restore `.previous`, restart it, and report the failed update.
- [ ] **Step 9: Refactor `bin/cli.ts` to call `runCli()`**. Import OpenTUI only inside the `attach`/`replay` code path via dynamic import. Hidden `daemon` loads daemon modules but no TUI module. Preserve `--cmd` only as a development/test override; installed production uses `runtime.json`.
- [ ] **Step 10: Implement `status` and logs commands without TUI**. Online status comes from IPC and prints daemon PID/uptime/RSS, child PID/state/restarts, retained calls, visual lease state, protocol version, history bytes, and log bytes. Offline status combines desired state plus `launchctl print`. `logs` reads rotated files oldest-to-newest; `--follow` watches the active file/rotation and streams new bounded lines.
- [ ] **Step 11: Run** the focused service/CLI/build tests, then `bun run build:prod`; require the build-layout probe to pass for either single or split layout.
- [ ] **Step 12: Run** `bun test && bun run typecheck && git diff --check` and confirm GREEN/exit 0.
- [ ] **Step 13: Commit** `git add src/platform/service-controller.ts src/cli bin scripts/build-production.ts src/daemon/run-daemon.ts src/launcher.ts package.json test/platform/service-controller.test.ts test/cli-main.test.ts test/build && git commit -m "feat: install and control desktop remote service"`.

### Task 6: Fault injection, soak tests, docs, and real macOS release gate

**Files:**
- Create: `scripts/soak.ts`
- Create: `scripts/soak-real.ts`
- Create: `test/integration/fault-injection.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Add `test:soak = bun run scripts/soak.ts`.
- Add `test:soak:real = bun run scripts/soak-real.ts`.
- `scripts/soak.ts` simulates 1,000,000 bounded runtime events, repeated child failures/restarts, and at least 1,000 visual attach/detach cycles.
- `scripts/soak-real.ts` defaults to 1,800,000 ms (30 minutes) and accepts `SOAK_DURATION_MS` only to shorten local debugging; release evidence uses the default.

- [ ] **Step 1: Write fault-injection tests** for child SIGKILL/exit, ten-failure degraded mode, client socket destroy without detach, stale socket entry, malformed/oversized IPC, oversized upstream no-newline input, corrupted history suffix, and persistence write failure. Each test asserts the documented recoverable terminal state rather than only "does not throw".
- [ ] **Step 2: Implement the accelerated soak harness**. Sample RSS after a 100,000-event warm-up and every 100,000 events thereafter. Fail if end RSS growth exceeds `max(64 MiB, 25% of warm-up RSS)`, if `/dev/fd` count grows by more than 4 after attach/detach churn, if retained calls exceed 50, if history exceeds 24 MiB, if logs exceed 6 MiB, or if fake runtime max concurrency exceeds 1.
- [ ] **Step 3: Run** `bun run test:soak` and keep its summary output as release evidence. It must reach 1,000,000 events with all hard bounds intact.
- [ ] **Step 4: Implement the real-time soak harness** using real timers, IPC sockets, repeated reconnect/backoff cycles, and idle periods. Sample RSS/FDs once per minute; use the same 64 MiB/25% growth and +4 FD acceptance thresholds after warm-up.
- [ ] **Step 5: Run a short developer proof** with `SOAK_DURATION_MS=120000 bun run test:soak:real`; fix timer/listener/socket leaks before proceeding. The final release gate later runs the default 30 minutes.
- [ ] **Step 6: Add a temporary-label real `launchd` smoke** that uses `com.desktop-remote.daemon.test.<pid>` and a harmless fake daemon/child. Verify bootstrap, KeepAlive recovery after `kill -9`, explicit disable+bootout staying stopped, enable+bootstrap restoring service, then remove the temporary LaunchAgent completely.
- [ ] **Step 7: Update README** with `desktop-remote`, `start`, `attach`, `status`, `restart`, `stop`, `logs [--follow]`, `install`, automatic login startup, one-TUI behavior, persistence limits, and the fact that closing the TUI leaves the daemon/remote session alive.
- [ ] **Step 8: Run final automated verification**:

```bash
bun test
bun run typecheck
bun run build:prod
bun run test:soak
bun run test:soak:real
git diff --check
```

The `test:soak:real` invocation for release uses its default 30-minute duration, not the short developer override.

- [ ] **Step 9: Perform the final real-service migration only after all commits are recoverable and losing the current development Remote Desktop Commander connection is acceptable**. From a local terminal run `desktop-remote install`, verify `desktop-remote status`, kill only the newly installed daemon once and verify `launchd` returns it, then `desktop-remote stop` and prove it stays stopped before `desktop-remote start` restores it.
- [ ] **Step 10: Run the macOS manual recovery checklist**: close/reopen TUI, force-kill TUI and reattach, sleep/wake, Wi-Fi disconnect/reconnect, VPN/WARP toggle, Internet loss/recovery, and confirm `status` converges to online/recovering states without manual daemon restart.
- [ ] **Step 11: Commit** `git add scripts package.json README.md test/integration/fault-injection.test.ts && git commit -m "test: harden desktop remote for long-running operation"`.

## Phase 3 final verification

Release readiness requires all of the following evidence from the same revision:

```bash
bun test
bun run typecheck
bun run build:prod
bun run test:soak
bun run test:soak:real
git diff --check
desktop-remote status
```

Expected: normal suite has zero failures; typecheck/build exit 0; production build selects a probed single or split layout without loading OpenTUI into the daemon; accelerated and 30-minute soak stay within memory/FD/disk/process bounds; the installed service reports healthy status; killing the daemon is recovered by `launchd`; intentional `stop` remains stopped; restarting the Mac/login later starts the service only when desired state is `running`.

Do not declare the months-long stability goal met from unit tests alone. The real-time soak, temporary-label launchd fault test, final real-service migration, and sleep/network recovery checklist are mandatory release evidence.
