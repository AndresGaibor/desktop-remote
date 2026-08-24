# Desktop Remote MCP Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the complete 24-tool Desktop Commander client contract with typed MCP schemas and local implementations.

**Architecture:** Keep the existing `StdioServerTransport -> OperationIpcClient -> daemon -> DesktopOperationExecutor` boundary. A single immutable schema registry becomes the source of truth for registered MCP tools; the executor translates its public compatibility inputs into focused filesystem, search, process, configuration, and telemetry services.

**Tech Stack:** Bun, TypeScript, Zod 4, `@modelcontextprotocol/server` 2, `bun:test`, `pdf-lib`, `exceljs`.

**Spec:** `docs/superpowers/specs/2026-08-24-desktop-remote-mcp-parity-design.md`

## Global Constraints

- Expose the 24 tools used by the Desktop Commander client; do not expose `give_feedback_to_desktop_commander`, `get_prompts`, or `track_ui_event`.
- Preserve the local daemon and tunnel architecture; do not reintroduce `@wonderwhy-er/desktop-commander` runtime code.
- Use immutable data updates and validate all MCP input through Zod schemas.
- Write each behavioral test first, run it red, then implement the smallest passing behavior.
- Do not install or update dependencies.
- Do not commit, push, or alter LaunchAgents without explicit user approval.

---

### Task 1: Typed MCP Tool Contract

**Files:**
- Create: `src/mcp/schemas.ts`
- Modify: `src/core/operations.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `test/mcp/tools.test.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Produces `toolSchemas: Readonly<Record<OperationName, z.ZodType>>`.
- Produces `createToolDefinitions()` entries containing `inputSchema`.
- `createMcpServer()` registers every tool with its individual Zod object schema.

- [ ] **Step 1: Write failing MCP contract tests**

```ts
test("publishes the start_process command argument schema", () => {
  const tool = createToolDefinitions().find(({ name }) => name === "start_process");
  expect(tool?.inputSchema.safeParse({ command: "pwd", timeout_ms: 1000 }).success).toBe(true);
  expect(tool?.inputSchema.safeParse({ command: ["pwd"] }).success).toBe(false);
});

test("publishes a non-empty schema for every registered operation", () => {
  for (const tool of createToolDefinitions()) {
    expect(tool.inputSchema).toBeDefined();
  }
});
```

- [ ] **Step 2: Run the MCP tests to verify red**

Run: `bun test test/mcp/tools.test.ts test/mcp/server.test.ts`

Expected: FAIL because `McpToolDefinition` has no `inputSchema` and `start_process` accepts no declared object schema.

- [ ] **Step 3: Add the immutable schema registry and tool definitions**

```ts
export const toolSchemas = {
  start_process: z.object({
    command: z.string().min(1),
    timeout_ms: z.number().int().positive(),
    shell: z.string().optional(),
    verbose_timing: z.boolean().optional(),
  }),
  list_directory: z.object({ path: z.string().min(1), depth: z.number().int().nonnegative().default(2) }),
  // Define the remaining 24 public operation schemas from the approved spec.
} as const;
```

Add `write_pdf` to `OPERATIONS`, change `McpToolDefinition.inputSchema` to its matching Zod object, and pass it directly to `server.registerTool` instead of `{}`.

- [ ] **Step 4: Run the MCP contract tests to verify green**

Run: `bun test test/mcp/tools.test.ts test/mcp/server.test.ts`

Expected: PASS; `start_process` and `list_directory` advertise typed input fields.

- [ ] **Step 5: Typecheck the tool contract**

Run: `bun run typecheck`

Expected: exit code 0.

### Task 2: Filesystem Compatibility Operations

**Files:**
- Modify: `src/filesystem/files.ts`
- Modify: `src/filesystem/directories.ts`
- Modify: `src/core/executor.ts`
- Test: `test/filesystem/files.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- Consumes `read_file`, `read_multiple_files`, `write_file`, `write_pdf`, and `list_directory` schemas from Task 1.
- Produces `readTextFile(path, { offset, length })`, `readUrl(url, { offset, length })`, and append-safe text writes.

- [ ] **Step 1: Write failing tests for multi-read, append, URL reads, depth, and write_pdf**

```ts
test("reads multiple paths in input order", async () => {
  await expect(executor.execute("read_multiple_files", { paths: [first, second] }))
    .resolves.toEqual(expect.objectContaining({ files: expect.arrayContaining([
      expect.objectContaining({ path: first, content: "one" }),
      expect.objectContaining({ path: second, content: "two" }),
    ]) }));
});

test("appends text when write_file uses append mode", async () => {
  await executor.execute("write_file", { path, content: "two", mode: "append" });
  await expect(readFile(path, "utf8")).resolves.toBe("onetwo");
});
```

Use Bun's local test server for `isUrl: true`; assert non-2xx responses reject with an actionable error. Add recursive directory fixtures that prove `depth: 0`, `1`, and `2` differ. Assert `write_pdf` creates the requested output path.

- [ ] **Step 2: Run the focused filesystem tests to verify red**

Run: `bun test test/filesystem/files.test.ts test/core/executor.test.ts`

Expected: FAIL with `Operation is not implemented` for multi-read and write_pdf, and no append/URL/depth behavior.

- [ ] **Step 3: Implement the minimum filesystem behavior**

```ts
export async function appendTextFile(path: string, content: string): Promise<void> {
  await appendFile(requirePath(path), content, "utf8");
}

async function readUrl(url: string, options: ReadTextFileOptions): Promise<TextPage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to read URL: ${response.status} ${response.statusText}`);
  return paginateText(await response.text(), options);
}
```

Dispatch `read_multiple_files`, `write_pdf`, URL reads, append writes, and `list_directory` depth from the executor. Retain atomic rewrite semantics. Do not treat URLs as local paths.

- [ ] **Step 4: Run focused tests to verify green**

Run: `bun test test/filesystem/files.test.ts test/core/executor.test.ts`

Expected: PASS.

### Task 3: Search Compatibility Inputs and Behavior

**Files:**
- Modify: `src/search/manager.ts`
- Modify: `src/core/executor.ts`
- Test: `test/search/manager.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- Consumes `start_search`, `get_more_search_results`, and `stop_search` schemas from Task 1.
- `SearchManager.start()` accepts `{ path, pattern, searchType, filePattern?, ignoreCase?, includeHidden?, contextLines?, maxResults? }`.

- [ ] **Step 1: Write failing compatibility tests**

```ts
test("starts a content search using Desktop Commander argument names", async () => {
  const search = await executor.execute("start_search", {
    path: directory, pattern: "NEEDLE", searchType: "content", ignoreCase: true,
  });
  const page = await executor.execute("get_more_search_results", {
    sessionId: (search as { id: string }).id, offset: 0, length: 10,
  });
  expect(page).toMatchObject({ results: [join(directory, "match.txt")] });
});
```

Add fixtures proving hidden files are excluded by default, `includeHidden: true` includes them, and `filePattern: "*.ts"` filters files before matching.

- [ ] **Step 2: Run search tests to verify red**

Run: `bun test test/search/manager.test.ts test/core/executor.test.ts`

Expected: FAIL because current input names are `root`, `mode`, and `id`.

- [ ] **Step 3: Rename public search inputs and implement filters**

Keep internal `SearchJob` state unchanged. Replace `root`/`mode` in the public `SearchOptions` with `path`/`searchType`; normalize case only when `ignoreCase` is true. Exclude dot-prefixed entries unless `includeHidden` is true. Use `filePattern` only as a filename filter.

- [ ] **Step 4: Run search tests to verify green**

Run: `bun test test/search/manager.test.ts test/core/executor.test.ts`

Expected: PASS.

### Task 4: Managed and System Process Operations

**Files:**
- Modify: `src/process/manager.ts`
- Modify: `src/core/executor.ts`
- Test: `test/process/manager.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- `ProcessManager.start(command: string, options)` returns `{ pid: number }` and retains writable stdin plus incremental output.
- `ProcessManager.readOutput(pid, options)`, `interact(pid, input, options)`, `terminate(pid)`, `listSessions()`, `listProcesses()`, and `kill(pid)` expose compatibility operations.

- [ ] **Step 1: Write failing process behavior tests**

```ts
test("sends input to a running interactive process", async () => {
  const started = await executor.execute("start_process", {
    command: "bun -e 'process.stdin.on(\"data\", x => console.log(x.toString().trim()))'", timeout_ms: 1_000,
  });
  await expect(executor.execute("interact_with_process", {
    pid: (started as { pid: number }).pid, input: "hello\n",
  })).resolves.toMatchObject({ output: expect.stringContaining("hello") });
});

test("lists and force terminates a tracked session", async () => {
  const started = await executor.execute("start_process", { command: "sleep 30", timeout_ms: 1_000 });
  await expect(executor.execute("list_sessions", {})).resolves.toContainEqual(expect.objectContaining({ pid: (started as { pid: number }).pid }));
  await expect(executor.execute("force_terminate", { pid: (started as { pid: number }).pid })).resolves.toMatchObject({ terminated: true });
});
```

Add a system-process test with the current Bun process PID and a validation test rejecting an unknown PID without sending a signal.

- [ ] **Step 2: Run process tests to verify red**

Run: `bun test test/process/manager.test.ts test/core/executor.test.ts`

Expected: FAIL because process tools are not implemented and current processes cannot accept stdin.

- [ ] **Step 3: Implement process lifecycle methods**

Run command strings through the explicitly selected shell (`zsh -lc` on macOS unless `shell` is supplied); use `stdin: "pipe"` and buffer output incrementally. Index managed sessions by numeric PID, not opaque UUID. Use `process.kill(pid, "SIGTERM")` for graceful local termination and `SIGKILL` only for `force_terminate`. Obtain system process data through `ps -axo pid=,ppid=,stat=,command=` with parsed numeric fields.

- [ ] **Step 4: Run process tests to verify green**

Run: `bun test test/process/manager.test.ts test/core/executor.test.ts`

Expected: PASS and no lingering test processes.

### Task 5: Local Configuration and Tool Telemetry

**Files:**
- Create: `src/config/store.ts`
- Modify: `src/core/executor.ts`
- Modify: `src/daemon/run-daemon.ts`
- Test: `test/config/store.test.ts`
- Test: `test/core/executor.test.ts`

**Interfaces:**
- `LocalStateStore.getConfig()`, `setConfigValue(key, value)`, `recordToolCall(entry)`, `getUsageStats()`, `getRecentToolCalls(filters)`.
- The daemon constructs one store and passes it into the executor; state is stored under the existing application-support directory atomically.

- [ ] **Step 1: Write failing local-state tests**

```ts
test("records an executed tool call and filters it by name", async () => {
  const executor = new DesktopOperationExecutor({ stateStore });
  await executor.execute("list_searches", {});
  await expect(executor.execute("get_recent_tool_calls", { toolName: "list_searches" }))
    .resolves.toMatchObject({ calls: [expect.objectContaining({ toolName: "list_searches" })] });
});

test("updates only a declared configuration key", async () => {
  await expect(executor.execute("set_config_value", { key: "fileReadLineLimit", value: 500 }))
    .resolves.toMatchObject({ fileReadLineLimit: 500 });
  await expect(executor.execute("set_config_value", { key: "unknown", value: true }))
    .rejects.toThrow(/configuration key/i);
});
```

- [ ] **Step 2: Run state tests to verify red**

Run: `bun test test/config/store.test.ts test/core/executor.test.ts`

Expected: FAIL because no state store or executor handlers exist.

- [ ] **Step 3: Implement atomic state persistence and telemetry**

Use a single JSON file with defaults: `blockedCommands`, `defaultShell`, `allowedDirectories`, `fileReadLineLimit`, `fileWriteLineLimit`, and `telemetryEnabled`. Validate allowed keys and value types before immutable replacement. Record successful and failed calls with tool name, timestamp, duration, and a redacted result summary; never persist secrets or complete file contents.

- [ ] **Step 4: Run state tests to verify green**

Run: `bun test test/config/store.test.ts test/core/executor.test.ts`

Expected: PASS; history filtering, limits, and invalid key rejection are covered.

### Task 6: Full MCP Regression and Tunnel Validation

**Files:**
- Modify: `test/mcp/server.test.ts`
- Modify: `test/core/operations.test.ts`
- Modify: `docs/superpowers/specs/2026-08-24-desktop-remote-mcp-parity-design.md` only if implementation reveals a required design correction.

**Interfaces:**
- The final `tools/list` response includes all 24 compatibility tools with non-empty object schemas.

- [ ] **Step 1: Write an end-to-end in-memory MCP test**

```ts
test("lists every public operation with its declared input schema", async () => {
  const tools = await listToolsThroughInMemoryTransport(createMcpServer(executor));
  expect(tools.tools).toHaveLength(24);
  expect(tools.tools.find(({ name }) => name === "start_process")?.inputSchema)
    .toMatchObject({ type: "object", properties: { command: expect.any(Object) } });
});
```

- [ ] **Step 2: Run the integration test to verify red**

Run: `bun test test/mcp/server.test.ts`

Expected: FAIL until every tool, including `write_pdf`, is registered and provides a serialized schema.

- [ ] **Step 3: Complete catalog assertions and any missing wiring**

Assert the exact 24-tool client set, no vendor feedback or prompt tool, and validation errors for missing required fields. Do not change runtime service configuration in this task.

- [ ] **Step 4: Run all automated verification**

Run: `bun test && bun run typecheck && bun run build:prod`

Expected: every command exits 0.

- [ ] **Step 5: Perform a non-destructive installed runtime smoke test**

Run: `curl -fsS http://127.0.0.1:61630/readyz`

Expected: `ready`.

Then run `tunnel-client doctor --profile-file "$HOME/Library/Application Support/desktop-remote/tunnel.yaml" --explain`.

Expected: `RESULT ok`.

Do not restart, unload, or rewrite the existing services during this validation.
