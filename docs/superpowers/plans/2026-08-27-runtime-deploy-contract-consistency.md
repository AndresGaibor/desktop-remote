# Runtime Deploy and Contract Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate stale launchd definitions and prevent MCP/daemon contract mismatches from executing tools, while making doctor and the production artifact gate prove the active runtime is coherent.

**Architecture:** Keep launchd lifecycle behavior in `LaunchdManager`, define one shared immutable runtime contract identity consumed by MCP and daemon IPC, and make doctor compare installed metadata, loaded service metadata, process identities, and hashes. The artifact gate will exercise the real MCP-to-daemon path instead of checking only registration.

**Tech Stack:** TypeScript, Bun, `bun:test`, macOS `launchctl`, Unix IPC, Zod MCP schemas, production artifact builder.

**Spec:** `docs/superpowers/specs/2026-08-27-runtime-deploy-contract-design.md`

## Global Constraints

- Do not change `allowedDirectories`, `blockedCommands`, `fileReadLineLimit`, or `fileWriteLineLimit`.
- MCP schemas remain unchanged during ChatGPT refresh and comparison.
- TDD order is failing test, minimal implementation, focused verification, full suite, typecheck, and production build.
- Contract mismatch must return `RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.` without executing the operation.
- Historical log errors must not make health false when active components and contract checks are healthy.
- Never expose secrets, process arguments containing sensitive values, or tool-call contents in diagnostics.

---

### Task 1: Real launchd definition reload

**Files:**
- Modify: `src/platform/launchd.ts:16-57`
- Test: `test/platform/launchd.test.ts`

**Interfaces:**
- Consumes: `LaunchdManagerOptions.run(command, args)` and existing `LaunchdManager.start()`.
- Produces: `start()` command sequence `bootout -> bootstrap -> enable -> kickstart`, with tolerant bootout errors for unloaded jobs.

- [ ] **Step 1: Write the failing transition test**

Add an in-memory launchctl fake that stores the active `ProgramArguments` and records calls. Start with a split layout (`desktop-remote-daemon`), then change the manager options to single layout (`desktop-remote daemon`) and call `start()` again. Assert the second sequence contains bootout and bootstrap, and that the fake active definition is `desktop-remote daemon`, not `desktop-remote-daemon`.

```ts
expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
  ["bootout", "gui/501/com.desktop-remote.daemon"],
  ["bootstrap", "gui/501"],
  ["enable", "gui/501/com.desktop-remote.daemon"],
  ["kickstart", "-k"],
]);
expect(activeDefinition).toEqual({ command: "desktop-remote", args: ["daemon"] });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test ./test/platform/launchd.test.ts`

Expected: FAIL because `start()` currently treats `already loaded` as success and does not replace the loaded definition.

- [ ] **Step 3: Implement the minimal reload sequence**

In `start()`, call `bootout` before `bootstrap`; reuse the existing not-found matcher so unloaded jobs are accepted. Treat `bootstrap` errors as fatal, then call `enable` and `kickstart`. Do not change `restart()` semantics.

- [ ] **Step 4: Run focused and platform tests**

Run: `bun test ./test/platform/launchd.test.ts ./test/platform/service-controller.test.ts`

Expected: PASS, including safe handling of `service not found` and `not loaded` bootout output.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`

```bash
git add src/platform/launchd.ts test/platform/launchd.test.ts
git commit -m "fix: reload launchd definitions during install"
```

### Task 2: Shared runtime contract identity and IPC guard

**Files:**
- Create: `src/runtime/contract.ts`
- Modify: `src/ipc/protocol.ts:1-170`
- Modify: `src/daemon/ipc-server.ts`
- Modify: `src/client/operation-ipc-client.ts:1-150`
- Modify: `src/mcp/handler.ts`
- Test: `test/runtime/contract.test.ts`
- Test: `test/client/operation-ipc-client.test.ts`
- Test: `test/ipc/protocol.test.ts`

**Interfaces:**
- Produces: `RuntimeContractIdentity { buildId: string; operationContractHash: string; protocolVersion: number }`.
- Produces: `getRuntimeContractIdentity(): RuntimeContractIdentity` and IPC status contract fields.
- Consumes: canonical MCP catalog from `createToolDefinitions()` and existing `PROTOCOL_VERSION`.

- [ ] **Step 1: Write failing identity and mismatch tests**

Test that the identity is deterministic, includes all three fields, and changes when the operation catalog changes. Test that an IPC client receiving a different daemon hash returns the exact mismatch error and does not send an operation request. Test that a matching identity permits the request.

```ts
expect(() => assertRuntimeContract({
  buildId: "mcp-a",
  operationContractHash: "daemon-hash",
  protocolVersion: PROTOCOL_VERSION,
})).toThrow(
  "RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.",
);
expect(executedRequests).toHaveLength(0);
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `bun test ./test/runtime/contract.test.ts ./test/client/operation-ipc-client.test.ts ./test/ipc/protocol.test.ts`

Expected: FAIL because no shared identity or preflight validation exists.

- [ ] **Step 3: Implement the shared identity**

Build the hash from the existing canonical tool definitions including names, schemas, and annotations. Keep the result immutable. Include the identity in daemon status IPC responses and expose it through the existing status request path.

- [ ] **Step 4: Implement the MCP-side preflight guard**

Have `OperationIpcClient` request status once before the first operation, compare protocol/build/hash fields, cache the successful validation, and reject mismatches before sending the operation frame. Make the handler return an MCP error result rather than attempting structured output validation for the failed call.

- [ ] **Step 5: Run focused tests and validate no secondary Zod error**

Run: `bun test ./test/runtime/contract.test.ts ./test/client/operation-ipc-client.test.ts ./test/ipc/protocol.test.ts ./test/mcp/handler.test.ts`

Expected: PASS and mismatch output contains `RUNTIME_VERSION_MISMATCH` without `Invalid structured content`.

- [ ] **Step 6: Typecheck, production build, and commit**

Run: `bun run typecheck && bun run build:prod`

```bash
git add src/runtime/contract.ts src/ipc/protocol.ts src/daemon/ipc-server.ts src/client/operation-ipc-client.ts src/mcp/handler.ts test/runtime/contract.test.ts test/client/operation-ipc-client.test.ts test/ipc/protocol.test.ts test/mcp/handler.test.ts
git commit -m "fix: guard MCP calls against runtime contract drift"
```

### Task 3: Doctor active versus historical health

**Files:**
- Modify: `src/doctor/doctor.ts:25-260`
- Modify: `src/cli/default-deps.ts:170-285`
- Modify: `src/platform/service-controller.ts`
- Modify: `src/platform/launchd.ts`
- Test: `test/doctor/doctor.test.ts`
- Test: `test/doctor/doctor-runtime-contract.test.ts`

**Interfaces:**
- Produces: `installedBuild`, `loadedService`, `mcp`, `daemon`, and `contract` report sections.
- Consumes: installed metadata, launchd/service status, daemon IPC status, MCP lifecycle identity, and log diagnostics.

- [ ] **Step 1: Write failing doctor report tests**

Cover: matching installed/loaded single layout is healthy; stale loaded split command is unhealthy; MCP/daemon hash mismatch is unhealthy; historical `recentErrors` with healthy active components yields `healthy: true` and appears under `historicalWarnings`.

```ts
expect(report.contract).toEqual({ mcpHash: "same", daemonHash: "same", matches: true });
expect(report.healthy).toBe(true);
expect(report.historicalWarnings).toEqual(["runtime error"]);
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `bun test ./test/doctor/doctor.test.ts ./test/doctor/doctor-runtime-contract.test.ts`

Expected: FAIL because the report does not expose active build/service/contract identity and historical errors currently affect health.

- [ ] **Step 3: Add report inputs and active health predicates**

Pass installed build metadata, loaded service command/args/pid, process executable/build identity, and both contract hashes through `DoctorDependencies`. Compare loaded arguments with the expected production layout and compare hashes explicitly.

- [ ] **Step 4: Separate warnings from current health**

Rename or split the serialized log field so historical warnings remain visible but are excluded from the `healthy` predicate. Preserve bounded and redacted diagnostics.

- [ ] **Step 5: Run focused tests, full suite, and typecheck**

Run: `bun test ./test/doctor/doctor.test.ts ./test/doctor/doctor-runtime-contract.test.ts && bun test && bun run typecheck`

Expected: PASS with no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/doctor/doctor.ts src/cli/default-deps.ts src/platform/service-controller.ts src/platform/launchd.ts test/doctor/doctor.test.ts test/doctor/doctor-runtime-contract.test.ts
git commit -m "fix: report active runtime and contract health"
```

### Task 4: Production artifact MCP-to-daemon regression

**Files:**
- Modify: `test/build/production-artifact.gate.ts`
- Modify: `scripts/build-production.ts` only if the test cannot launch both produced artifacts without changing runtime behavior
- Test: `test/build/production-artifact.gate.ts`

**Interfaces:**
- Consumes: production artifact layout, MCP stdio entrypoint, daemon IPC socket, and structured output schemas.
- Produces: an end-to-end assertion for `start_process` followed by `read_process_output` from the same build.

- [ ] **Step 1: Write the failing E2E assertions**

Extend the existing artifact test to launch the daemon and MCP from one temporary build directory. Call `start_process` with `printf contract-ok`, parse the structured response, extract its positive pid/id, then call `read_process_output(pid)` and validate the response against the existing output schema.

```ts
const started = await callTool("start_process", { command: "printf contract-ok" });
expect(started).toMatchObject({ resultType: "success", pid: expect.any(Number), id: expect.any(String) });
const output = await callTool("read_process_output", { pid: started.pid });
expect(output).toMatchObject({ resultType: "success", stdout: expect.stringContaining("contract-ok") });
```

- [ ] **Step 2: Run the artifact test to verify RED**

Run: `bun test ./test/build/production-artifact.gate.ts`

Expected: FAIL until the test exercises the daemon and validates both structured responses.

- [ ] **Step 3: Implement only the test harness wiring**

Use the existing production build and temporary socket/process cleanup helpers. Do not loosen schemas or bypass the IPC client. Ensure both artifacts are from the same build directory and terminate the child process in a `finally` block.

- [ ] **Step 4: Run artifact, full suite, typecheck, and build**

Run: `bun test ./test/build/production-artifact.gate.ts && bun test && bun run typecheck && bun run build:prod`

Expected: PASS with both structured calls validated.

- [ ] **Step 5: Commit**

```bash
git add test/build/production-artifact.gate.ts scripts/build-production.ts
git commit -m "test: exercise production MCP daemon contract"
```

### Task 5: Integration verification and deployment

**Files:**
- No production source changes expected.
- Verify: all files from Tasks 1-4.

- [ ] **Step 1: Run complete verification**

Run: `bun test && bun run build:prod && bun run typecheck`

Expected: all tests pass, production build succeeds, and typecheck exits zero.

- [ ] **Step 2: Inspect final diff and status**

Run: `git status --short && git diff --check && git log --oneline -10`

Expected: only intended commits/files are present; unrelated dirty files remain untouched.

- [ ] **Step 3: Deploy through the official installer**

Run: `bun run bin/cli.ts install`

Expected: launchd definition is booted out, bootstrapped from the current plist, enabled, and kickstarted.

- [ ] **Step 4: Verify active runtime identity**

Run: `"$HOME/Library/Application Support/desktop-remote/bin/desktop-remote" doctor --json`

Expected: loaded service arguments match the installed layout; MCP and daemon hashes match; active health is healthy. Historical warnings may be present without forcing unhealthy.

- [ ] **Step 5: Validate ChatGPT snapshot observationally**

Refresh/update the MCP app in ChatGPT, open a new normal chat, compare its exposed schemas with `createToolDefinitions()`, and only after exact agreement call `get_config`, `start_process` with hostname, and `read_process_output`. Do not modify schemas during this validation.
