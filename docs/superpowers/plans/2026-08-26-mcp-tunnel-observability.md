# MCP Tunnel Observability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Secure MCP Tunnel failures diagnosable after the control channel is unavailable, and provide a local readiness check that distinguishes daemon, tunnel, and MCP transport failures.

**Architecture:** Keep MCP stdout protocol-only. Persist tunnel process stdout/stderr through the platform service manager, persist sanitized MCP startup/transport lifecycle events to a dedicated rotating JSONL log, and add a `tunnel status` probe that reads the dynamic health URL and checks `/healthz` plus `/readyz`. Telemetry is best-effort and must never become an availability dependency. Do not add speculative automatic restart loops; recovery remains explicit until the new telemetry identifies the failing boundary.

**Tech Stack:** TypeScript, Bun, Node.js fs/fetch, MCP stdio, launchd/systemd, existing `RotatingDaemonLog`.

**Spec:** `docs/CHATGPT_MCP_RUNBOOK.md`

## Global Constraints

- Never write secrets, tunnel API keys, tokens, or tool arguments to logs.
- MCP stdout is reserved exclusively for MCP stdio protocol traffic.
- A logging failure must never prevent MCP startup, disconnect a healthy transport, or mask the original transport error.
- macOS logs live below `~/Library/Application Support/desktop-remote/logs`.
- Linux should continue to use systemd/journald for tunnel stdout/stderr.
- Tests must be written first and observed failing before production changes.

---

### Task 1: Add CI verification

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `package.json` scripts `test` and `typecheck`.
- Produces: GitHub Actions verification for pull requests and pushes to `main`.

- [ ] **Step 1:** Add checkout + Bun setup + frozen install + `bun test` + `bun run typecheck`.
- [ ] **Step 2:** Open the hardening PR and confirm the workflow executes.

### Task 2: Persist macOS tunnel process logs

**Files:**
- Modify: `test/platform/tunnel-services.test.ts`
- Modify: `src/platform/tunnel-services.ts`
- Modify: `src/platform/tunnel-install.ts`

**Interfaces:**
- Consumes: tunnel profile path and `paths.logsDir`.
- Produces: launchd `StandardOutPath` and `StandardErrorPath` pointing to `tunnel.stdout.log` and `tunnel.stderr.log`.

- [ ] **Step 1:** Extend the launchd test to require both log paths.
- [ ] **Step 2:** Run tests and confirm the new assertion fails.
- [ ] **Step 3:** Generate escaped log paths in the launchd plist and ensure `logsDir` exists during tunnel initialization.
- [ ] **Step 4:** Run the focused test and full suite.

### Task 3: Add best-effort MCP lifecycle logging

**Files:**
- Create: `src/mcp/run-stdio-server.ts`
- Create: `test/mcp/run-stdio-server.test.ts`
- Modify: `src/cli/default-deps.ts`
- Modify: `bin/mcp.ts`

**Interfaces:**
- Consumes: `DesktopRemotePaths`, an MCP server, `StdioServerTransport`, and `RotatingDaemonLog`.
- Produces: `runMcpStdioServer()` that logs sanitized process startup, successful stdio attachment, and transport-start failure without logging MCP payloads. Logger failures are swallowed so observability cannot break MCP availability or mask transport errors.

- [ ] **Step 1:** Write tests against an injected logger/server/transport proving lifecycle and failure events are emitted without payload data.
- [ ] **Step 2:** Run tests and confirm the module is missing/failing.
- [ ] **Step 3:** Add failing tests proving logger failure cannot prevent transport connection or replace the original transport error.
- [ ] **Step 4:** Implement the lifecycle wrapper and route both MCP entry points through it.
- [ ] **Step 5:** Run focused and full tests plus typecheck.

### Task 4: Add tunnel liveness/readiness status

**Files:**
- Create: `src/platform/tunnel-health.ts`
- Create: `test/platform/tunnel-health.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/default-deps.ts`
- Modify: `docs/CHATGPT_MCP_RUNBOOK.md`

**Interfaces:**
- Consumes: the dynamic tunnel health URL file, injected `readFile`/`fetch` for tests.
- Produces: `probeTunnelHealth()` returning the health base URL and separate live/ready HTTP statuses; CLI `desktop-remote tunnel status` prints JSON.

- [ ] **Step 1:** Write failing tests for healthy, alive-but-unready, missing URL file, unreachable endpoint, and non-loopback URL cases.
- [ ] **Step 2:** Run tests and confirm failure.
- [ ] **Step 3:** Implement bounded local-only health probing and expose it through the CLI.
- [ ] **Step 4:** Update the runbook to use the new command before raw curl fallback.
- [ ] **Step 5:** Run full tests and typecheck.

### Task 5: Runtime recovery and version verification

**Files:**
- No repository file is required unless installation behavior needs adjustment after diagnosis.

**Interfaces:**
- Consumes: installed tunnel-client version, `tunnel status`, tunnel/MCP logs.
- Produces: restored live connector and evidence identifying the failure boundary.

- [ ] **Step 1:** Verify the installed tunnel-client against the latest public release.
- [ ] **Step 2:** Upgrade if stale using the supported installation path and restart only the tunnel LaunchAgent.
- [ ] **Step 3:** Confirm `/healthz` and `/readyz` are both healthy and that the MCP child is present.
- [ ] **Step 4:** Call a read-only Remote Desktop Mac tool from ChatGPT and inspect the new logs/status if it fails.
