# Desktop Remote Agent Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop Remote safe and reliable for long-lived, high-volume agent operation while adding integrated diagnostics, transactional updates, and native macOS control tools.

**Architecture:** Preserve `MCP stdio -> Unix IPC -> daemon -> focused operation services`. Add bounded operation contexts (trace/deadline/cancellation), shared redaction/summary utilities, resource-safe process/search/file services, tunnel diagnostics, and a macOS-only adapter. Observability remains best-effort and never changes operation semantics.

**Tech Stack:** TypeScript 5.9, Bun 1.3.x, Node child_process/fs/crypto APIs, Zod 4, MCP server/client 2, launchd/systemd user services, tunnel-client >=0.0.13, macOS osascript/screencapture/native event helper.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-runtime-hardening-design.md`

## Global Constraints

- Do not enforce `allowedDirectories`, `blockedCommands`, `fileReadLineLimit`, or `fileWriteLineLimit` in this iteration.
- Preserve the daemon + Unix IPC + MCP stdio architecture.
- Do not introduce a privileged background helper or cloud database.
- MCP stdout remains protocol-only.
- Logging/telemetry failures are never availability dependencies.
- Every production behavior change follows RED -> GREEN -> full focused verification.
- Preserve Node import compatibility for daemon/admin modules.
- Never persist raw secrets or complete unbounded tool payloads.

---

### Task 1: Baseline compatibility and MCP contract conformance

**Files:**
- Modify: `test/tunnel/config.test.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/core/executor.ts`
- Test: `test/mcp/tools.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- Produces public schemas whose optional fields have real executor behavior.
- Removes unsupported public fields rather than silently ignoring them.

- [ ] Add failing tests proving `edit_block` range/content/expected_replacements and search context/deadline fields are either implemented or absent.
- [ ] Add a compatibility test that discovers the installed tunnel-client doctor flag (`--profile-file` on 0.0.13) instead of hardcoding obsolete `--config`.
- [ ] Run focused tests and verify RED.
- [ ] Implement minimal schema/executor alignment.
- [ ] Run focused tests and typecheck; commit `fix: enforce MCP contract conformance`.

### Task 2: Best-effort telemetry and unified redaction

**Files:**
- Modify: `src/config/store.ts`
- Modify: `src/core/executor.ts`
- Modify: `src/logging/redactor.ts`
- Create: `src/telemetry/tool-call-summary.ts`
- Test: `test/core/executor.test.ts`
- Test: `test/config/store.test.ts`
- Test: `test/logging/rotating-log.test.ts`

**Interfaces:**
- Produces `summarizeToolCall(name, input, result?, error?)` bounded metadata.
- `ConfigStore.recordToolCall()` persists already-redacted summaries.

- [ ] Add failing tests: successful mutation stays successful when telemetry persistence throws; original failure remains original when telemetry throws; embedded Bearer/sk/github/slack secrets disappear from history.
- [ ] Verify RED.
- [ ] Route all recursive/string redaction through `logging/redactor.ts`; store summaries/hashes/byte counts instead of raw contents.
- [ ] Make telemetry recording best-effort and isolated.
- [ ] Verify focused/full tests; commit `fix: isolate telemetry from operation results`.

### Task 3: Operation context, cancellation, deadlines and IPC correlation

**Files:**
- Modify: `src/ipc/protocol.ts`
- Modify: `src/daemon/ipc-server.ts`
- Modify: `src/client/operation-ipc-client.ts`
- Modify: `src/mcp/handler.ts`
- Modify: `src/core/executor.ts`
- Create: `src/core/operation-context.ts`
- Test: `test/client/operation-ipc-client.test.ts`
- Test: `test/daemon/ipc-server.test.ts`
- Test: `test/mcp/handler.test.ts`

**Interfaces:**
- Produces `OperationContext { traceId, signal, deadlineAt? }`.
- IPC operation requests carry `traceId` and optional `deadlineAt`.
- Client `execute()` accepts `{ timeoutMs?, signal?, traceId? }`.

- [ ] Add failing tests for timeout, abort, trace propagation, and transport survival after one expired request.
- [ ] Verify RED.
- [ ] Implement per-request AbortController/deadline cleanup without closing shared MCP stdio.
- [ ] Verify GREEN/full focused tests; commit `feat: propagate operation cancellation and trace ids`.

### Task 4: Resource-safe process manager

**Files:**
- Rewrite: `src/process/manager.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/output-schemas.ts`
- Modify: `src/core/executor.ts`
- Test: `test/process/manager.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- `start_process` accepts `cwd`, `env`, timeout.
- Output returns separate bounded `stdout`/`stderr`, byte cursors, truncation metadata.
- Completed sessions expire by TTL and max retained count.

- [ ] Add failing tests for cwd, separate stderr, bounded output, timeout, graceful/force termination, process-group kill, retention eviction.
- [ ] Verify RED.
- [ ] Replace Bun-specific spawn with `node:child_process.spawn`, bounded chunk buffers, timers, and cleanup.
- [ ] Update schemas/output contracts.
- [ ] Verify under Bun and Node-compatible import tests; commit `feat: bound managed process resources`.

### Task 5: Streaming files, safe edits and response budgets

**Files:**
- Modify: `src/filesystem/files.ts`
- Modify: `src/filesystem/edit.ts`
- Modify: `src/filesystem/directories.ts`
- Create: `src/filesystem/hash.ts`
- Create: `src/core/response-budget.ts`
- Modify: `src/mcp/handler.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/output-schemas.ts`
- Test: filesystem + MCP handler tests

**Interfaces:**
- File reads stream requested lines and return truncation/page metadata.
- Writes/edits accept `expected_sha256` and preserve file mode.
- `edit_block` supports exact and range mode plus `expected_replacements`.
- Large list results use bounded pagination/cursors.
- MCP handler emits concise text for large structured results instead of duplicating JSON.

- [ ] Add failing tests for huge-file early stop, URL body guard/abort, expected hash conflict, preserved mode, atomic edit, range edit, response text deduplication, paged process listing/directory listing.
- [ ] Verify RED.
- [ ] Implement streaming/hash/atomic helpers and common response budget.
- [ ] Verify; commit `feat: add streaming IO and optimistic edits`.

### Task 6: Incremental search engine

**Files:**
- Rewrite: `src/search/manager.ts`
- Modify: `src/core/executor.ts`
- Modify: search schemas/output schemas
- Test: `test/search/manager.test.ts`

**Interfaces:**
- Content result items contain `path`, `line`, `column`, `match`, `before`, `after`.
- `getMore()` can return available results before traversal completes.
- Search obeys contextLines, timeout, earlyTermination, maxResults, cancellation and TTL cleanup.

- [ ] Add failing tests for context lines, early first page, stop/abort, timeout, hidden files, file glob, maxResults, session eviction.
- [ ] Verify RED.
- [ ] Implement incremental async traversal/line scanning; optional rg optimization only behind identical behavior.
- [ ] Verify; commit `feat: make searches incremental and cancellable`.

### Task 7: Backpressure and bounded daemon operation scheduling

**Files:**
- Create: `src/core/operation-scheduler.ts`
- Modify: `src/core/executor.ts`
- Test: `test/core/operation-scheduler.test.ts`
- Test: integration fault injection

**Interfaces:**
- Scheduler classes: `light`, `heavy`, `process`, `document`.
- Bounded queue; cancellation removes queued work; saturation returns typed busy error.

- [ ] Add failing tests for concurrency caps, FIFO fairness, queue ceiling, cancellation before start, no leaked slots.
- [ ] Verify RED.
- [ ] Implement scheduler and route executor operations by class.
- [ ] Verify fault tests; commit `feat: add daemon operation backpressure`.

### Task 8: Doctor JSON, tunnel metrics, schema fingerprint and support bundle

**Files:**
- Create: `src/diagnostics/doctor.ts`
- Create: `src/diagnostics/tunnel-status.ts`
- Create: `src/diagnostics/schema-fingerprint.ts`
- Create: `src/diagnostics/support-bundle.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/default-deps.ts`
- Modify: `src/platform/install.ts`
- Modify: `src/mcp/tools.ts`
- Test: diagnostics + CLI tests

**Interfaces:**
- `desktop-remote doctor [--json]`
- `desktop-remote support-bundle [path]`
- Safe loopback retrieval of tunnel `/api/status`, `/api/system`, selected `/metrics`.
- SHA-256 fingerprint of canonical MCP definitions persisted in installed build metadata.

- [ ] Add failing parser/CLI tests with fixture tunnel responses and stale-poll/schema-change warnings.
- [ ] Verify RED.
- [ ] Implement bounded diagnostics and local redacted bundle (tar/zip using available platform tool or deterministic directory fallback).
- [ ] Verify; commit `feat: add integrated runtime diagnostics`.

### Task 9: Conservative self-healing

**Files:**
- Create: `src/diagnostics/recovery-policy.ts`
- Modify: CLI/service control integration
- Test: `test/diagnostics/recovery-policy.test.ts`

**Interfaces:**
- Pure classifier returns `healthy | observe | restart_tunnel | circuit_open` from local evidence/history.
- Restart budget has bounded attempts/window/cooldown.

- [ ] Add failing tests proving control-plane failure alone never restarts; dead local health can restart; budget opens circuit; recovery resets after healthy period.
- [ ] Verify RED.
- [ ] Implement opt-in `desktop-remote repair` and reuse classifier in doctor recommendation; do not add an aggressive permanent watcher.
- [ ] Verify; commit `feat: add conservative tunnel recovery policy`.

### Task 10: Transactional rollback/update operations

**Files:**
- Modify: `src/platform/install.ts`
- Modify: service controller/CLI deps
- Modify: `src/cli/main.ts`
- Test: install + CLI tests

**Interfaces:**
- `desktop-remote rollback` atomically swaps current/previous runtime, restarts daemon and verifies status.
- `desktop-remote update-local` builds/tests current checkout, promotes it, restarts and automatically rolls back on failed health.

- [ ] Add failing filesystem/service tests for successful rollback and automatic rollback after failed health.
- [ ] Verify RED.
- [ ] Implement atomic metadata/executable restoration and health gate.
- [ ] Verify; commit `feat: add transactional local update rollback`.

### Task 11: macOS native control adapter and MCP tools

**Files:**
- Create: `src/macos/automation.ts`
- Create: `src/macos/events.swift` or build-on-demand native helper source
- Modify: operation registry/schemas/output schemas/executor/tool registration
- Test: `test/macos/automation.test.ts`
- Test: MCP catalog tests

**Interfaces:**
- macOS-only operations: active/list windows, open/focus app, screenshot, clipboard get/set, type/key/click/double-click/scroll/drag.
- Native command adapter is injectable for tests and returns actionable permission errors.

- [ ] Add failing command-construction/parsing tests and platform-gating tests.
- [ ] Verify RED.
- [ ] Implement osascript/screencapture/native CGEvent helper with no privileged daemon.
- [ ] Verify macOS smoke for read-only active window/list windows/screenshot and non-destructive clipboard read; commit `feat: add native macOS agent controls`.

### Task 12: Documentation, compatibility gates and final installation smoke

**Files:**
- Modify: `README.md`
- Modify: `docs/CHATGPT_MCP_RUNBOOK.md`
- Modify: `docs/SETUP.md`
- Update CI if needed.

**Interfaces:**
- Docs explicitly state the four compatibility config values are stored but not enforced.
- Runbook uses `doctor --json`, schema fingerprint, support bundle and recovery policy.

- [ ] Update docs and CLI help.
- [ ] Run `bun test`, `bun run typecheck`, `bun run build:prod`, Node import compatibility, and focused integration tests.
- [ ] Install branch build into a temporary isolated profile first and run doctor/MCP stdio smoke.
- [ ] Review diff for secrets/generated artifacts.
- [ ] Commit `docs: document hardened agent runtime`.

## Final verification

- [ ] `bun test` => 0 failures.
- [ ] `bun run typecheck` => exit 0.
- [ ] `bun run build:prod` => exit 0.
- [ ] Node daemon/admin import compatibility => pass.
- [ ] `desktop-remote doctor --json` reports healthy against the real local runtime after installation.
- [ ] tunnel `/healthz` and `/readyz` => 200.
- [ ] MCP stdio integration initializes and lists the hardened tools.
- [ ] Read-only ChatGPT `get_config` or equivalent succeeds after connector refresh if the schema fingerprint changed.
