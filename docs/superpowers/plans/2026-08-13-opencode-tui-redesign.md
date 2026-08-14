# OpenCode-Style TUI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard-like TUI with a simple OpenCode-style activity view with semantic color and content-aware detail highlighting.

**Architecture:** Keep `SessionStore` and `DesktopCommanderRuntime` unchanged. Move visual semantics into pure view-model/output-classifier helpers, keep theme tokens isolated, and let `app.tsx` compose a single-column activity screen plus a focused detail screen.

**Tech Stack:** Bun, TypeScript, SolidJS, OpenTUI 0.5.3, bun:test.

## Global Constraints

- Desktop Commander continues to own authentication, remote connectivity, heartbeat, routing and MCP execution.
- No permanent split-pane detail view at any width.
- Color must be semantic and status must remain readable without color.
- Use OpenTUI `<code>`/Tree-sitter for known source and JSON content; no new highlighting dependency.
- Preserve replay, JSONL logging, pipe mode and graceful shutdown behavior.
- Develop UI behavior test-first and keep all existing non-UI tests green.

---### Task 1: Semantic activity view model

**Files:**
- Create: `src/tui/theme.ts`
- Modify: `src/tui/view-model.ts`
- Test: `test/tui/view-model.test.ts`

**Interfaces:**
- Produces: `statusVisual(status)`, `connectionVisual(status)`, `buildActivityRows(snapshot, width)`, `buildContextSummary(snapshot, width)`.
- Keeps: `buildDetailLines` only as plain-text fallback for unknown output.

- [ ] Add RED tests asserting selected marker, status text/glyph, concise empty state, target truncation and no split-pane behavior.
- [ ] Run `bun test test/tui/view-model.test.ts` and confirm the new assertions fail.
- [ ] Add semantic theme tokens and implement the pure activity/context helpers.
- [ ] Remove `shouldUseSplitPane`; the hierarchy must not depend on terminal width.
- [ ] Run focused tests and `bun run typecheck`.
- [ ] Commit as `feat: simplify tui activity model`.

Example assertion:
```ts
const row = buildActivityRows(snapshot(), 80)[0];
expect(row?.text).toContain("✓ read_file");
expect(row?.selected).toBe(true);
expect(buildEmptyState(emptySnapshot())).toEqual(["Waiting for tool calls…", "MCP activity will appear here automatically."]);
```
### Task 2: Content-aware detail renderer

**Files:**
- Create: `src/tui/output-renderer.ts`
- Test: `test/tui/output-renderer.test.ts`

**Interfaces:**
- Produces: `classifyDetailContent(row): DetailContent` with kinds `code | json | diagnostics | shell | plain`.
- Produces: `inferFiletype(path, content)` and `classifyDiagnosticLine(line)` for semantic lint/test emphasis.

- [ ] Write RED tests for `.ts/.tsx/.js/.json`, JSON payloads, Bun/Jest/ESLint-like output, shell output and plain fallback.
- [ ] Run `bun test test/tui/output-renderer.test.ts` and confirm RED because the module is missing.
- [ ] Implement deterministic classification without changing the event/result text.
- [ ] Detect diagnostic line roles: `pass`, `fail`, `error`, `warning`, `location`, `summary`, `normal`.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: classify tui detail output`.

Example:
```ts
expect(classifyDetailContent(row({ path: "src/app.ts", resultText: "const n: number = 1" }))).toMatchObject({ kind: "code", filetype: "typescript" });
expect(classifyDiagnosticLine("error src/app.ts:12:4 Unexpected any").role).toBe("error");
expect(classifyDiagnosticLine(" 37 pass").role).toBe("pass");
```
### Task 3: OpenCode-style screen and interactions

**Files:**
- Modify: `src/tui/app.tsx`
- Test: `test/tui/app.test.tsx`

**Interfaces:**
- Consumes: activity rows/theme/detail classification from Tasks 1-2.
- Produces: activity screen, focused detail screen, temporary search/help/auth surfaces.

- [ ] Extend `testRender` coverage: no `Details` side panel on wide terminals, empty state, colored-status text, `Enter` detail, `Esc` activity, `/` search, `?` help.
- [ ] Confirm RED against the current dashboard layout.
- [ ] Replace permanent split-pane boxes with a single activity scroll area and compact contextual summary.
- [ ] Render selected activity with both `›` and cyan background/accent; render success/running/failure using semantic colors.
- [ ] Full detail uses OpenTUI `<code>` for `code/json`; diagnostics render line-by-line semantic colors; shell/plain use readable text fallback.
- [ ] Reduce footer to `↑↓ navigate · Enter details · / search · ? help` and show filter only when active.
- [ ] Keep `Ctrl+C` delegated to existing `onQuit`; do not touch runtime/networking.
- [ ] Run `bun test test/tui/app.test.tsx test/tui/view-model.test.ts test/tui/output-renderer.test.ts` and typecheck.
- [ ] Commit as `feat: redesign tui around activity`.

Smoke expectations:
```ts
expect(frame).toContain("Tool calls");
expect(frame).not.toContain("Details");
expect(frame).toContain("Waiting for tool calls");
```
### Task 4: Documentation and live MCP smoke

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents the final UI hierarchy, controls, semantic colors and detail highlighting.

- [ ] Update README screenshots/text descriptions to remove the old permanent split-pane model.
- [ ] Run the full `bun test` and `bun run typecheck`.
- [ ] Run `rg '@wonderwhy-er/desktop-commander/dist/remote-device|RemoteChannel|supabase' src bin` and require no matches.
- [ ] Start the real TUI on the Mac and invoke safe MCP calls (`list_sessions`, `read_file`, short `start_process`) so running/completed/result states are visible.
- [ ] Verify a controlled failed read is clearly red and a test/lint-like result receives diagnostic highlighting.
- [ ] Commit documentation/smoke adjustments as `docs: document redesigned tui` if README changes remain.

## Final verification

Run:
```bash
bun test
bun run typecheck
bun audit
rg '@wonderwhy-er/desktop-commander/dist/remote-device|RemoteChannel|supabase' src bin
```

Expected: all tests/typecheck pass; forbidden import grep is empty. Audit findings inherited from pinned OpenTUI/Desktop Commander are reported rather than bypassed with unsafe upgrades.
