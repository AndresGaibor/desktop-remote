# Agent Runtime Diagnostics and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing doctor with bounded loopback tunnel diagnostics, add a redacted support-bundle command, and add opt-in conservative tunnel repair without changing operation, search, process, or macOS control behavior.

**Architecture:** Evolve `src/doctor/doctor.ts`, `src/config/schema-hash.ts`, and the existing CLI dependency graph. Keep tunnel inspection read-only and loopback-only; normalize only selected status/system/metrics fields. Keep recovery as a pure policy over local evidence and persisted bounded restart history, with an explicit CLI repair entry point and no watcher.

**Tech Stack:** TypeScript, Bun test, Node fs/net/crypto APIs, existing `tunnel-health`, service-controller, redactor, and schema-hash modules.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-runtime-hardening-design.md`

## Global Constraints

- Do not touch edit/search/process manager/macOS controls.
- Do not enforce `allowedDirectories`, `blockedCommands`, `fileReadLineLimit`, or `fileWriteLineLimit`.
- `doctor --json` and support-bundle collection are read-only, bounded, loopback-only, and tolerant of unavailable components.
- Never persist secrets, raw config, full tunnel payloads, or full tool payloads.
- Control-plane failure alone never causes a restart; launchd/systemd remain the supervisors.
- Use RED → GREEN → REFACTOR; do not commit.

### Task 1: Normalize bounded tunnel diagnostics

**Files:**
- Modify: `src/platform/tunnel-health.ts`
- Test: `test/platform/tunnel-health.test.ts`

**Interfaces:**
- Produce `probeTunnelDiagnostics()` and selected `TunnelDiagnostics` data for `/healthz`, `/readyz`, `/api/status`, `/api/system`, and `/metrics`.
- Accept only validated HTTP loopback URLs and cap endpoint/metrics parsing.

- [ ] Add failing tests for loopback-only endpoint requests, selected polling/queue/worker/MCP/channel/PID fields, redacted bounded responses, and unavailable optional endpoints.
- [ ] Run the focused tunnel test and verify the expected RED failure.
- [ ] Implement the smallest parser/probe that passes those tests without returning raw payloads.
- [ ] Run the focused tunnel test and typecheck.

### Task 2: Evolve doctor and schema/build metadata

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `src/config/schema-hash.ts`
- Modify: `src/cli/default-deps.ts`
- Test: `test/doctor/doctor.test.ts`
- Test: `test/config/schema-hash.test.ts`

**Interfaces:**
- Keep existing `runDoctor()` compatibility while adding local health, control-plane stale status, selected tunnel diagnostics, PIDs/channel/MCP status, bounded recent logs, build metadata, and schema fingerprint metadata.
- Add read-only data collection that catches missing/unavailable daemon, tunnel, metrics, build, log, and schema files.

- [ ] Add failing doctor tests for stale polling with local health, optional endpoint failures, selected fields, bounded errors, and schema metadata.
- [ ] Run focused tests and verify RED.
- [ ] Implement report composition and canonical schema metadata using existing functions.
- [ ] Run focused tests and typecheck.

### Task 3: Add bounded redacted support bundle CLI

**Files:**
- Create: `src/doctor/support-bundle.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/default-deps.ts`
- Test: `test/doctor/support-bundle.test.ts`
- Test: `test/cli-main.test.ts`

**Interfaces:**
- Add `desktop-remote support-bundle [path]` with a deterministic bounded directory fallback containing only `doctor.json`, `build.json`, `tunnel.json`, and sanitized bounded logs.
- Use the shared recursive/string redactor and never read/copy raw config or complete payload/history files.

- [ ] Add failing tests for CLI routing, bounded output, redaction, and omission of config/history/payload files.
- [ ] Run focused tests and verify RED.
- [ ] Implement local bundle writing with mode `0700` directory and `0600` files.
- [ ] Run focused tests and typecheck.

### Task 4: Add pure recovery policy and opt-in repair

**Files:**
- Create: `src/doctor/recovery-policy.ts`
- Create: `src/doctor/repair.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/default-deps.ts`
- Test: `test/doctor/recovery-policy.test.ts`
- Test: `test/cli-main.test.ts`

**Interfaces:**
- Produce `healthy | observe | restart_tunnel | circuit_open` from local liveness/readiness/process evidence and bounded restart history.
- Add `desktop-remote repair` that evaluates once and restarts only a locally provably dead/stuck tunnel, subject to budget/window/cooldown.

- [ ] Add failing tests proving stale control-plane data observes, dead local health restarts, cooldown/budget opens the circuit, and healthy state resets history.
- [ ] Run focused tests and verify RED.
- [ ] Implement pure policy plus one-shot repair orchestration; do not add a permanent watcher.
- [ ] Run focused tests, full tests, typecheck, and production build.

## Verification checklist

- [ ] `bun test`
- [ ] `bun run typecheck`
- [ ] `bun run build:prod`
- [ ] `git diff --check` and review that only diagnostics/recovery files changed.
