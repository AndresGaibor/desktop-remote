# Desktop Remote Agent Runtime Hardening Design

## Goal

Harden Desktop Remote for long-lived, high-volume agent use while preserving the current local daemon + Unix IPC + MCP stdio + optional OpenAI tunnel architecture. The work must improve correctness, failure isolation, bounded resource usage, diagnostics, update safety, and agent ergonomics without enforcing `allowedDirectories`, `blockedCommands`, `fileReadLineLimit`, or `fileWriteLineLimit` at runtime in this iteration.

## Current architecture

```text
ChatGPT / MCP client
        |
        v
OpenAI tunnel-client (optional)
        |
        v
Desktop Remote MCP stdio
        |
        v
OperationIpcClient (Unix socket)
        |
        v
Desktop Remote daemon
        |
        +--> filesystem
        +--> searches
        +--> managed processes
        +--> config / usage history
```

The architecture remains. This project does not introduce an HTTP control server or a second database.

## Scope

### 1. Contract correctness

The MCP schema, output schema, annotations, and executor behavior must describe the same capability. Fields currently exposed but ignored (`edit_block.range`, `content`, `expected_replacements`; `start_search.contextLines`, `timeout_ms`, `earlyTermination`; process timing fields; spreadsheet options where unsupported) must either be implemented or removed from the public schema. Contract tests must fail whenever a public field has no executor behavior.

### 2. Observability must never alter operation success

Persistence of recent tool calls and operational telemetry is best-effort. If the underlying operation succeeds, a later telemetry write failure must never turn the MCP result into a failure. If an operation fails, telemetry failure must never replace the original operational error.

### 3. One redaction pipeline

All persisted/logged diagnostic values use the shared recursive redactor from `src/logging/redactor.ts`. Tool-call history stores summaries rather than arbitrary full payloads/results. Secrets embedded inside generic strings such as command lines, URLs, headers, or tool content are redacted using the same string-level patterns as operational logs.

### 4. Bounded process sessions

Managed process stdout and stderr are stored separately in bounded ring-like buffers. A completed session is retained for a bounded count and/or TTL and then evicted. Callers can page output using byte cursors. Processes expose `cwd`, optional environment overrides, timeout, graceful terminate, force terminate, and process-group termination where supported. Process execution uses portable Node child-process APIs so it works under Bun and Node.

### 5. Bounded and incremental searches

Searches traverse incrementally and return match objects containing path plus line/column/context for content searches. They must not read an entire tree before the first page can be consumed. `timeout_ms`, cancellation, `contextLines`, `maxResults`, `earlyTermination`, hidden-file behavior, and file patterns are real behavior. Use `rg` when available only as an optimization; the TypeScript fallback remains authoritative and tested.

### 6. Streaming file reads and response budgets

Text file reads stream until the requested line page is satisfied rather than loading the full file. URL reads stream with a body-size guard and abort support. Large list operations return bounded pages with cursors/metadata rather than unbounded arrays. MCP response generation avoids duplicating large structured payloads as an equally large text JSON copy.

### 7. End-to-end cancellation and deadlines

Each operation request has a trace/request id and optional deadline. Cancellation propagates from MCP handler to IPC request to the executor and into long-running filesystem/network/search/process waits. Expired or cancelled operations fail independently; the shared MCP stdio transport remains alive.

### 8. Safe concurrent edits

Mutation tools support optimistic concurrency using `expected_sha256`. If the file changed since the agent read it, the operation returns a conflict instead of overwriting. Text rewrite/edit operations use atomic replacement and preserve existing file mode where practical. `edit_block` implements both exact replacement and explicit range replacement; `expected_replacements` is honored.

### 9. Integrated doctor and tunnel diagnostics

Add `desktop-remote doctor [--json]` that composes:

- daemon service/process state;
- daemon IPC request;
- installed build metadata;
- MCP/tunnel process relationship where available;
- `/healthz` and `/readyz`;
- safe subsets of tunnel `/api/status` and `/api/system`;
- selected control-plane/dispatcher metrics;
- schema hash;
- log-path existence and recent sanitized diagnostic summary.

The doctor command must be read-only and bounded. Local tunnel HTTP endpoints are accepted only on loopback.

### 10. Correlation IDs

Every MCP operation receives a correlation id propagated through IPC and daemon execution. Logs include lifecycle milestones, tool name, duration, status, response size, and correlation id, but not raw tool payloads.

### 11. Conservative self-healing

Add a local health evaluator that can classify healthy, degraded, and repairable tunnel conditions. Automatic recovery is limited to locally provable stuck/dead conditions and uses a restart budget/circuit breaker. It must never restart merely because the OpenAI control plane is unreachable. launchd/systemd remain the primary process supervisors.

### 12. Schema fingerprint

Canonicalize registered MCP tool definitions and calculate a SHA-256 fingerprint. Expose it through doctor/status metadata. Persist the installed fingerprint so doctor can warn that the connector metadata may require a refresh after tool contract changes.

### 13. Backpressure

Daemon operation execution has bounded concurrency by workload class (light filesystem, heavy search/document/process). Excess operations wait in a bounded queue or fail with a clear busy error rather than growing without limit. Cancellation removes queued operations.

### 14. Transactional install, update and rollback

Build promotion already keeps `.previous`; formalize it. Installation records installed build metadata. Add rollback support that atomically restores the previous executable/layout, restarts the service, and verifies health. Add a local update path only when it can reuse the repository checkout/build pipeline; do not invent a remote auto-updater service.

### 15. Support bundle

Add a read-only diagnostic bundle command that writes a local archive containing bounded, redacted Desktop Remote logs, doctor JSON, build metadata, and tunnel diagnostics. Never include raw config secrets or full tool payloads. Prefer tunnel-client's supported diagnostic surfaces instead of scraping private state.

### 16. macOS agent controls

Add a focused macOS control subsystem as a separate adapter behind explicit MCP tools, using native OS facilities and existing user permissions:

- `get_active_window`
- `list_windows`
- `open_app`
- `focus_window`
- `screenshot`
- `get_clipboard`
- `set_clipboard`
- `type_text`
- `key_press`
- `click`
- `double_click`
- `scroll`
- `drag`

The implementation must not introduce a permanent privileged helper. Use macOS native binaries/APIs (`osascript`, `screencapture`, and a small compiled/native helper only when coordinate events require it). Screen/Accessibility permission failures must return actionable errors, not trigger retries.

GUI tools are registered only on macOS; non-macOS builds keep the existing portable operation set plus non-GUI hardening.

## Explicitly out of scope

This iteration does **not** enforce these existing configuration values:

- `allowedDirectories`
- `blockedCommands`
- `fileReadLineLimit`
- `fileWriteLineLimit`

They remain stored for compatibility but are not described as active security controls in docs/tool copy. Do not add path sandboxing or command blocklists in this work.

Also out of scope:

- a cloud database;
- a new remote control plane;
- hidden privilege escalation;
- a remote unattended updater service;
- destructive GUI action confirmation logic inside Desktop Remote (the MCP client/user approval layer remains responsible for approvals).

## Failure semantics

- Operational success wins over telemetry failure.
- Original operational failure wins over telemetry failure.
- Cancellation/timeout is scoped to one operation.
- Oversized output is truncated/paginated, not allowed to exhaust memory.
- Concurrency saturation is explicit and bounded.
- Self-healing never loops indefinitely.
- If doctor sees local health healthy but control-plane polling stale, it reports the distinction rather than restarting the daemon.

## Compatibility

- Bun remains the primary development/test runtime.
- Daemon/admin graph remains importable under Node.js.
- macOS launchd and Linux systemd user services remain supported.
- tunnel-client 0.0.13 is the current tested tunnel baseline; tests must tolerate newer compatible releases where CLI syntax differs by discovering supported flags instead of hardcoding obsolete `doctor --config` behavior.

## Verification gates

At completion:

```bash
bun test
bun run typecheck
bun run build:prod
```

must pass from a shell environment with the repository's required executables on PATH.

Focused tests must cover telemetry failure isolation, secret redaction, process output limits/GC, streaming reads, incremental search/cancellation, edit conflicts, IPC timeout/correlation, response budgeting, doctor parsing, schema hash, backpressure, rollback, and macOS adapter command construction/error handling.

A final local smoke test must verify:

1. daemon IPC operation;
2. `desktop-remote doctor --json`;
3. tunnel health/readiness;
4. MCP stdio initialization/tool listing;
5. one read-only MCP operation through ChatGPT after installation.
