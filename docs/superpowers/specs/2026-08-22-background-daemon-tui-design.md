# Desktop Remote Background Daemon and Optional TUI Design

Date: 2026-08-22
Status: Design approved in chat; pending written-spec review

## Goal

Refactor `desktop-remote` so the long-lived Desktop Commander connection is owned by a lightweight background daemon rather than by OpenTUI. The daemon must be able to run for weeks or months with bounded memory, bounded disk usage, automatic recovery, and minimal idle CPU usage on macOS.

The TUI becomes an optional, disposable client. Closing or crashing the TUI must never terminate the daemon or the official `desktop-commander` process.

## User-facing behavior

The default command remains ergonomic:

```bash
desktop-remote
```

It checks whether the daemon is running and attaches the TUI. On first use or ordinary absence it starts/enables the daemon automatically. If the persisted desired state is explicitly `stopped`, the default command does **not** override that decision; it exits with a clear message instructing the user to run `desktop-remote start`.

Explicit administration commands are also supported:

```bash
desktop-remote start
desktop-remote attach
desktop-remote status
desktop-remote restart
desktop-remote stop
desktop-remote logs
desktop-remote logs --follow
desktop-remote install
```

`desktop-remote start` enables and starts the LaunchAgent without opening the TUI. `attach` only connects and fails clearly if the daemon is unavailable. `restart` performs a controlled daemon restart. `stop` is persistent: it records the desired stopped state and disables/unloads the LaunchAgent until a later `start`.

Only one visual TUI may be attached at a time. Administrative commands such as `status` and `logs` remain available while the TUI lease is held.

## Architecture

```text
macOS launchd
    |
    v
desktop-remote daemon
    |-- supervisor
    |    `-- desktop-commander remote --persist-session
    |-- upstream parser
    |-- SessionStore (max 50 calls)
    |-- bounded persistence
    |-- bounded rotating logs
    `-- Unix domain socket IPC
             |
             `-- optional desktop-remote TUI client
```

The daemon is the long-lived product. The TUI is a client and never owns, starts, or stops Desktop Commander during normal attach/detach.

The daemon must not import `@opentui/core`, `@opentui/solid`, `solid-js`, or modules under `src/tui`. An architectural test must enforce this boundary.

## Proposed module boundaries

```text
src/daemon/   daemon lifecycle, supervisor, IPC server, health, persistence
src/client/   IPC client and attach orchestration
src/platform/ launchd installation and desired-state management
src/runtime/  official Desktop Commander child + parsing
src/session/  bounded canonical connection/call history
src/logging/  redaction and bounded rotating logs
src/tui/      optional OpenTUI/Solid renderer
```

The daemon owns only canonical connection/device/auth/call state. Search query, status filter, selected call, filtered rows, scroll position, and detail-view state are TUI/client concerns and must not live in the long-running daemon. The current `SessionStore` is therefore split or narrowed during migration so presentation state remains local to the attached TUI.

## Daemon supervision and recovery

The daemon owns exactly zero or one Desktop Commander child. A child exit never directly terminates the daemon.

Unexpected child failure enters `recovering` and retries with bounded exponential backoff: 1s, 2s, 5s, 10s, 30s, then 60s maximum. After five minutes of healthy operation, the backoff resets to 1s.

Ten consecutive child failures without a five-minute healthy period enter a degraded circuit-breaker state. The daemon remains responsive to IPC and retries at a slow interval of five minutes until recovery or intentional stop. A successful five-minute healthy period clears the failure counter and resets normal backoff. This prevents CPU/log storms while preserving autonomous recovery.

The supervisor must enforce the invariant that no restart path can leave two Desktop Commander children alive concurrently. Old stdout/stderr listeners and process handles are released before a replacement becomes active.

On macOS sleep, the daemon does not inhibit system sleep. After wake/network changes, Desktop Commander is given a recovery window. If the remote child remains unhealthy for 60 seconds after execution/network resumes, the supervisor restarts only the child.

The daemon itself is protected by a user LaunchAgent. Unexpected daemon crashes are restarted by `launchd` with throttling. Intentional `desktop-remote stop` disables/unloads the LaunchAgent so it stays stopped.

On `SIGTERM` or `SIGINT`, the daemon stops accepting new visual attaches, closes IPC clients, asks Desktop Commander to shut down gracefully, flushes bounded persistence/log state, removes its owned socket, and exits. `SIGKILL` is treated as unrecoverable in-process and is handled by `launchd` on the next daemon start.

## IPC protocol

IPC uses a Unix domain socket, not TCP. The default location is:

```text
~/Library/Caches/desktop-remote/daemon.sock
```

The socket directory is private to the current user. Application-support/cache directories are `0700`; `desired-state.json`, session/history state, runtime metadata, and daemon log files are `0600`. Startup validates ownership before accepting clients. The socket bind is also the single-daemon authority: if a socket already exists, startup first probes it. Only an unresponsive filesystem entry that is owned by the current UID, is not a symlink, and is verified as a Unix socket may be removed as stale; otherwise startup fails safely instead of deleting an arbitrary path.

Live IPC may carry the temporary authentication URL/code that the user must see in the TUI, but those ephemeral auth secrets are never written to history or daemon logs. Persisted runtime/session content remains redacted.

The protocol is newline-delimited JSON with an explicit `protocolVersion`. Initial message families are `hello`, `snapshot.request`, `snapshot.begin`, `snapshot.call`, `snapshot.end`, `subscribe`, `event`, `status.request`, `status`, `ping`, `pong`, `attach`, `detach`, `already-attached`, and `shutdown`.

A newly attached TUI receives the bounded initial snapshot as a short sequence (`snapshot.begin`, at most 50 `snapshot.call` frames, `snapshot.end`) and then only incremental events. This avoids constructing one giant snapshot frame. There is no polling loop for session updates.

The daemon grants a single exclusive visual lease. A second `attach` receives `already-attached` and exits without creating another OpenTUI renderer. Socket EOF immediately releases the lease. While attached, a 30-second heartbeat is used only as a fallback; three consecutive missed heartbeat windows release a pathological stale lease.

If the daemon itself restarts while the TUI is open, the TUI stays alive in a visible `reconnecting` state and retries the socket with 1s, 2s, 5s, 10s, then 30s maximum delay. It reacquires the visual lease and requests a fresh snapshot when the daemon returns. If desired state becomes explicitly `stopped`, the TUI exits cleanly instead of continuing to reconnect.

IPC framing has an initial hard maximum of 512 KiB per frame. Because snapshots are streamed one call per frame, this remains compatible with the per-call telemetry limits. Oversized or malformed messages are rejected without unbounded buffering or process termination.

## Resource limits

Bounded resource usage is a correctness requirement, not an optimization.

The same history limit applies everywhere:

```text
SessionStore       <= 50 calls
persisted history  <= 50 calls
IPC snapshot       <= 50 calls
TUI                <= 50 calls
```

Per-call telemetry is also bounded. Initial hard limits are 64 KiB retained arguments, 32 KiB retained metadata, 256 KiB retained result text, and 32 KiB retained error text. Oversized values preserve useful head/tail context and include an explicit truncation marker with original size when known.

These limits affect only desktop-remote observability. They must not truncate the actual MCP response delivered by the official Desktop Commander process.

Upstream stdout/stderr framing also has an initial 2 MiB maximum unterminated line/remainder size so a child that emits data without newlines cannot grow `stdoutRemainder` or `stderrRemainder` indefinitely. An oversized diagnostic line is converted into a bounded truncation/error event and discarded from the observability parser; this must not alter the actual MCP response path owned by Desktop Commander.

The daemon is event-driven. It must not use frequent polling timers for process state, files, IPC, or rendering. Timers exist only for bounded concerns such as backoff, health recovery, shutdown deadlines, and low-frequency lease heartbeat.

## Persistence

Persistence stores only enough normalized, redacted data to restore the latest 50 calls and minimal daemon metadata after a restart. No database is required.

Production paths:

```text
~/Library/Application Support/desktop-remote/desired-state.json
~/Library/Application Support/desktop-remote/state.json
~/Library/Application Support/desktop-remote/history.jsonl
~/Library/Application Support/desktop-remote/runtime.json
~/Library/Application Support/desktop-remote/logs/
```

The persisted history has a 24 MiB hard file-size ceiling. Appends are performed only for normalized bounded events; before an append would cross the ceiling, the daemon compacts atomically to the latest 50 calls. With the per-call limits above, 50 maximally retained calls fit below that ceiling. Durable replacements use a temporary file, close/fsync the temporary file, then use atomic rename so a crash cannot expose a partially rewritten state file.

Corrupted optional history must not prevent daemon startup. It is reported as a warning and discarded or recovered conservatively. `desired-state.json` is separate from recoverable session history and is written atomically. The daemon treats only the explicit values `running` and `stopped` as valid desired states; missing state on first install is initialized to `running`.

All persisted runtime/session content passes through the existing secret redaction policy before it reaches disk.

## Logging

Daemon logs are quiet by default and retain lifecycle, reconnect, authentication, restart, warning, and error information rather than every heartbeat or low-level event.

Logs are size-rotated and globally bounded. The initial production policy is three files of at most 2 MiB each (about 6 MiB total). The implementation may change these constants later only with tests that preserve a hard total bound.

`desktop-remote logs` reads recent logs and `desktop-remote logs --follow` streams them without loading the TUI.

## macOS integration

The production daemon runs as the current user through:

```text
~/Library/LaunchAgents/com.desktop-remote.daemon.plist
```

It never requires root or a system LaunchDaemon. The initial plist uses `RunAtLoad=true`, `KeepAlive=true`, and a 10-second `ThrottleInterval`; disabling the job is the mechanism that makes an intentional stop persistent. `launchd` protects the daemon; the daemon supervisor independently protects Desktop Commander.

The installed service executes from a stable application-support path, not directly from the Git repository, so branch changes, `git pull`, dependency installation, or source edits cannot mutate a running service unexpectedly. The LaunchAgent must not depend on an interactive shell PATH. During install, desktop-remote resolves and validates stable absolute paths for the official Desktop Commander executable/runtime and records them in `runtime.json`. Production installation must provision the pinned official package version in a stable runtime location when the discovered executable would otherwise point into the source checkout.

`desktop-remote stop` atomically writes desired state `stopped`, disables the LaunchAgent to prevent KeepAlive respawn, requests graceful daemon shutdown over IPC, waits for exit, and finally boots out any leftover service instance if necessary. `desktop-remote start` writes `running`, enables/bootstrap-loads the LaunchAgent, waits for the socket, and verifies health. The daemon also checks desired state at startup and exits immediately if it is `stopped`, protecting against races or accidental direct invocation. `desktop-remote restart` leaves desired state `running`, requests a graceful daemon exit, allows the enabled LaunchAgent to respawn it, and waits for a new healthy daemon instance.

## Build and installation

Development continues to use Bun/TypeScript directly. Production first attempts a Bun compiled executable and accepts that layout only if OpenTUI and its native dependencies pass packaging and runtime tests. If that single-artifact layout loads renderer/native state into the daemon or is unreliable, production uses the approved two-artifact fallback. Compiling is a distribution and isolation decision; memory benefits must be measured rather than assumed.

The preferred installation flow is:

```text
build temporary artifact
verify executable
atomically install stable artifact
install/update LaunchAgent
controlled restart
wait for IPC + health OK
```

A previous known-good binary is retained during update so a failed new executable can be rolled back instead of leaving the service unavailable.

If bundling daemon and OpenTUI into one executable forces the daemon to load unnecessary renderer/native state or proves unreliable, the approved fallback is two compiled artifacts: a minimal daemon executable and a CLI/TUI executable. Stability and idle footprint take priority over single-file distribution.

Both IPC data and persisted state carry explicit version numbers (`protocolVersion` and `stateVersion`). Incompatible clients fail with a clear restart/update message rather than undefined parsing behavior.

## Status and observability

`desktop-remote status` queries the daemon directly when possible and reports enough bounded diagnostics to detect degradation without a web server or metrics stack. Expected fields include daemon PID/uptime/RSS, Desktop Commander PID/state/restart count, retained-call count, TUI attached/detached state, IPC protocol version, persistence size, and bounded log size.

Status collection itself must be lightweight and must not cause periodic work when nobody requests it.

## Testing strategy

The normal suite adds unit and integration coverage for supervisor policy, IPC framing/versioning, exclusive attach, persistence/compaction, resource truncation, logging rotation, desired-state behavior, and architectural dependency boundaries. Existing TUI behavior remains covered separately.

Fault-injection tests intentionally kill or corrupt components: Desktop Commander SIGKILL/exit errors, repeated crash loops, TUI SIGKILL, client disconnect without detach, stale socket files, malformed/oversized IPC messages, oversized upstream lines, corrupted optional history, and persistence write failures. Each case must converge to a documented recoverable state.

The accelerated soak target `bun run test:soak` drives hundreds of thousands to one million simulated events and repeated attach/detach and child restart cycles. It records RSS/heap trend, file-descriptor count, process count, persisted-file sizes, and verifies the retained state never exceeds configured limits.

The release soak target `bun run test:soak:real` runs for 30-60 minutes with real idle periods, timers, reconnects, and churn to expose leaked timers/listeners that instantaneous stress tests may miss.

A macOS manual/release checklist covers real LaunchAgent install/start/status/restart/stop semantics, `kill -9` daemon recovery, sleep/wake, Wi-Fi changes, VPN/WARP changes, loss/restoration of Internet, and TUI crash followed by successful reattach.

Memory acceptance is trend-based rather than an arbitrary fixed RSS number: after warm-up, memory and file descriptors must not grow proportionally with total historical event count. Idle CPU must remain effectively near zero with no frequent polling or needless disk writes.

## Acceptance criteria

Implementation is not complete until all of these properties are verified:

- daemon and TUI are independent processes/lifecycles;
- closing or killing the TUI leaves daemon and Desktop Commander alive;
- exactly one visual TUI lease is allowed;
- at most 50 calls exist in memory, persistence, IPC snapshots, and TUI state;
- per-call telemetry, IPC frames, and upstream remainder buffers have hard size limits;
- daemon code has no OpenTUI/Solid imports;
- Desktop Commander child failures recover automatically with bounded backoff/circuit breaker;
- the supervisor never owns more than one Desktop Commander child;
- `launchd` recovers an unexpected daemon crash;
- intentional `desktop-remote stop` remains stopped across launchd behavior;
- last 50 calls survive daemon restart through bounded redacted persistence;
- log files remain bounded under sustained warning/error output;
- corrupted optional history cannot block daemon startup;
- repeated attach/detach and child restarts do not leak file descriptors/listeners;
- compiled production artifact passes real macOS execution and IPC tests;
- LaunchAgent install/update flow passes end-to-end health verification;
- full `bun test` and `tsc --noEmit` pass;
- accelerated soak passes without resource growth proportional to event count;
- real-time release soak passes before declaring long-duration readiness.

## Migration from the current architecture

The existing `DesktopCommanderRuntime`, parser, `SessionStore`, redactor, and TUI view components are reused where their responsibilities already match the new boundaries, unless tests demonstrate that a component violates the new resource/lifecycle guarantees. `TuiSessionBridge` is not retained as owner of the runtime: event consumption/logging moves into the daemon and the TUI consumes IPC snapshots/events instead.

The current default 50-call pruning remains, but truncation must move earlier so huge args/results cannot live unbounded inside those 50 rows. Existing JSONL replay remains a development/diagnostic feature. Daemon persistence may use JSONL framing internally only if reads are streaming/bounded; it must never require loading an unbounded whole history file into memory.

CLI mode selection will be refactored so TTY presence no longer implies ownership of Desktop Commander. Pipe compatibility and replay behavior remain supported unless a concrete implementation conflict is discovered and separately approved.

## Non-goals

This design does not replace Desktop Commander's official authentication, transport, heartbeat, routing, or MCP implementation. It does not add a web UI, HTTP server, TCP listener, cloud database, telemetry backend, multi-user daemon, or multiple simultaneous TUIs.

It does not prevent macOS sleep and does not promise remote connectivity while the machine itself is asleep or offline. The guarantee is bounded local recovery when execution/network becomes available again.

Rust is not part of the initial implementation. It is considered only if measured Bun idle/runtime costs remain materially higher than desired after the daemon/TUI separation and resource limits are implemented.

## Design decision summary

Use a Bun/TypeScript background daemon supervised by macOS `launchd`, a versioned local Unix-socket protocol, one exclusive optional TUI client, strict memory/disk/framing limits, bounded persistence of the latest 50 calls, layered restart/backoff protection, compiled installed artifacts, and soak/fault-injection verification.

This preserves the official Desktop Commander process as the network/session authority while making the UI disposable and the long-lived supervisor small, observable, and recoverable.
