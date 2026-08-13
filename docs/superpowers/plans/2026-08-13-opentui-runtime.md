# Desktop Remote OpenTUI Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an interactive OpenTUI frontend and typed local runtime supervisor around the official Desktop Commander remote executable.

**Architecture:** Keep `desktop-commander remote` as the connectivity boundary. Convert local output into typed events, feed a framework-independent session store, and render it with OpenTUI/Solid.

**Tech Stack:** Bun, TypeScript, bun:test, Desktop Commander, OpenTUI, SolidJS.

## Global Constraints

- Keep the official Desktop Commander process responsible for remote connectivity.
- Do not import its private remote-device modules.
- Use `callId` for tool identity and timing.
- Preserve non-interactive pipe behavior.
- Redact sensitive values before persistent logging.
- Follow RED -> GREEN -> REFACTOR for production behavior changes.
- Finish with green tests and typecheck.

---
### Task 1: Typed events and parser contract

**Files:**
- Create: `src/runtime/events.ts`
- Create: `src/runtime/upstream-parser.ts`
- Test: `test/runtime/upstream-parser.test.ts`
- Modify: existing parser helpers only as needed for strict TypeScript.

**Interfaces:**
- Produces: `RuntimeEvent`, `ToolStartedEvent`, `ToolCompletedEvent`, `ToolFailedEvent`.
- Produces: `UpstreamParser.pushLine(line, source)` and `UpstreamParser.flush()`.

- [ ] Write failing tests for auth, device ready, tool start/completion/failure and concurrent same-name calls.
- [ ] Run `bun test test/runtime/upstream-parser.test.ts` and confirm RED.
- [ ] Implement discriminated events and parser using `callId` timing.
- [ ] Run the focused test and full `bun test`.
- [ ] Fix existing strict indexing/type errors without weakening `tsconfig`.
- [ ] Run `bunx tsc --noEmit` and commit.

### Task 2: Runtime supervisor and graceful shutdown

**Files:**
- Create: `src/runtime/desktop-commander-runtime.ts`
- Test: `test/runtime/desktop-commander-runtime.test.ts`
- Modify: `src/launcher.ts`

**Interfaces:**
- Produces: `DesktopCommanderRuntime.start()`, `.stop()`, `.onEvent(listener)`.
- Consumes: `UpstreamParser` and installed `desktop-commander` binary.
- [ ] Write a failing runtime test with a fake child adapter that asserts spawn args and SIGINT shutdown.
- [ ] Run the focused test and confirm RED.
- [ ] Implement process supervision with injected spawn function for tests.
- [ ] Ensure stdout/stderr feed the parser and child exit becomes a runtime event.
- [ ] Verify graceful stop waits, then escalates after timeout only when needed.
- [ ] Run focused and full tests, then commit.

### Task 3: Session store, filtering, selection and replay state

**Files:**
- Create: `src/session/store.ts`
- Create: `src/session/types.ts`
- Test: `test/session/store.test.ts`

**Interfaces:**
- Produces: `SessionStore.consume(event)`, `.snapshot()`, `.moveSelection(delta)`, `.setQuery(query)`, `.setStatusFilter(filter)`.
- Snapshot includes connection status, tool rows, selected call, counts and filtered rows.

- [ ] Write failing tests for started/completed/failed transitions, ordering, query filtering, status filtering and selection bounds.
- [ ] Confirm focused tests fail for missing store.
- [ ] Implement minimal immutable snapshot logic with bounded in-memory history.
- [ ] Verify focused and full tests and commit.

### Task 4: Redacted JSONL logging and replay

**Files:**
- Create: `src/logging/redactor.ts`
- Create: `src/logging/jsonl.ts`
- Test: `test/logging/jsonl.test.ts`

**Interfaces:**
- Produces: `redactEvent(event)`, `JsonlEventWriter`, `readJsonlEvents(path)`.
- [ ] Write failing tests that prove auth codes, bearer tokens, cookies, access tokens and refresh tokens are removed before serialization.
- [ ] Confirm RED.
- [ ] Implement recursive redaction and JSONL writer/reader.
- [ ] Verify replay preserves safe event fields and rejects malformed lines with line numbers.
- [ ] Run focused/full tests and commit.

### Task 5: OpenTUI/Solid interactive application

**Files:**
- Create: `bunfig.toml`
- Create: `src/tui/app.tsx`
- Create: `src/tui/run-tui.tsx`
- Create: `src/tui/view-model.ts`
- Test: `test/tui/view-model.test.ts`
- Modify: `package.json`, `bun.lock`, `tsconfig.json`.

**Interfaces:**
- Produces: `runTui({ store, runtime, logWriter })`.
- Produces: pure `buildTimelineRows(snapshot, width)` and detail-view helpers for deterministic tests.

- [ ] Add OpenTUI/Solid dependencies and required Bun preload/JSX configuration.
- [ ] Write failing pure view-model tests for compact rows, detail text, status footer and narrow layout.
- [ ] Confirm RED, then implement the view model.
- [ ] Build the Solid screen with header, timeline, detail pane and status/footer.
- [ ] Add `useKeyboard` bindings for arrows/j/k, Enter, `/`, `f`, `?`, Esc and Ctrl+C.
- [ ] Keep shutdown delegated to `DesktopCommanderRuntime.stop()` before destroying renderer.
- [ ] Use `testRender` for a smoke render test where practical.
- [ ] Run focused/full tests and typecheck, then commit.
### Task 6: CLI integration, replay mode and compatibility output

**Files:**
- Modify: `bin/cli.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/cli-mode.test.ts`

**Interfaces:**
- Interactive default: launches runtime + TUI.
- `replay <file>`: loads safe JSONL events without spawning Desktop Commander.
- Piped stdin: preserves line-oriented formatter compatibility.
- `--log-jsonl <file>`: persists redacted runtime events.

- [ ] Write failing mode-selection tests covering TTY, piped input and replay.
- [ ] Confirm RED.
- [ ] Refactor CLI orchestration into small testable functions and wire runtime/TUI/replay modes.
- [ ] Preserve forwarding of unknown Desktop Commander arguments.
- [ ] Update README with architecture boundary, controls, logging and replay examples.
- [ ] Run `bun test`, `bun run typecheck`, dependency audit and a `--cmd true` smoke test.
- [ ] Verify no imports from `@wonderwhy-er/desktop-commander/dist/remote-device` exist.
- [ ] Commit final integration.

## Final verification

Run:

```bash
bun test
bun run typecheck
bun audit
rg '@wonderwhy-er/desktop-commander/dist/remote-device|RemoteChannel|supabase' src bin
```

Expected: tests and typecheck pass; source grep has no forbidden remote-infrastructure imports. Audit findings inherited from Desktop Commander are reported separately rather than bypassed with unsafe upgrades.
