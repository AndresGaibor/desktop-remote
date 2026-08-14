# TUI UX Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the OpenCode-style TUI with complete wrapped activity, stable terminal-style follow behavior, tool-aware detail views, and denser contextual controls.

**Architecture:** Keep Desktop Commander runtime/protocol boundaries unchanged. Move multi-line activity rendering into a focused `ActivityFeed`, keep follow/keyboard behavior as pure interaction state, and add pure tool-detail presentation helpers consumed by `CallDetailView`.

**Tech Stack:** Bun, TypeScript, SolidJS 1.9.12, OpenTUI 0.5.3, `@wonderwhy-er/desktop-commander` 0.2.47.

## Global Constraints

- Desktop Commander remains responsible for authentication, remote connectivity, device registration, heartbeat, MCP routing, and tool execution.
- Do not add remote server, Supabase, WebSocket, token/auth backend, remote-channel, heartbeat, user-management, server-deployment, or MCP transport code.
- Long commands, paths, written content, arguments, and results must never use ellipsis for information loss; use wrapping, scrolling, or explicit collapse/expand instead.
- Calls remain logical selection units even when rendered across multiple terminal lines.
- Semantic color remains restrained: cyan focus/location, green success/PASS, amber running/warning, red failure/error, muted gray metadata.
- Preserve keyboard-only operation and graceful `DesktopCommanderRuntime.stop()` shutdown.

---
## File structure

- Modify `src/session/store.ts`: add an explicit jump-to-newest filtered selection operation used by follow mode.
- Modify `src/tui/view-model.ts`: replace one-line truncated rows with logical multi-line activity blocks and search counters.
- Create `src/tui/activity-feed.tsx`: render logical call blocks, selected-background continuation lines, and OpenTUI sticky scrolling.
- Modify `src/tui/interaction.ts`: add `End`, argument toggle, and pure follow-state transitions.
- Create `src/tui/tool-detail.ts`: extract tool-specific read/write/edit/process presentations without changing event data.
- Modify `src/tui/detail-view.tsx`: prioritize Result, collapse Arguments, render Content/diff presentations.
- Modify `src/tui/app.tsx`: compose the feed, follow state, search counter, and contextual footer/help.
- Modify/add focused tests under `test/session/` and `test/tui/`.

### Task 1: Wrapped logical activity blocks

**Files:**
- Modify: `src/session/store.ts`
- Modify: `src/tui/view-model.ts`
- Modify: `test/session/store.test.ts`
- Modify: `test/tui/view-model.test.ts`

**Interfaces:**
- Produces: `SessionStore.selectLastFiltered(): void`.
- Produces: `ActivityBlockView { callId, selected, tone, status, lines, target, duration }`.
- Produces: `buildActivityBlocks(snapshot, width): ActivityBlockView[]` and `buildSearchCounter(snapshot): string`.
- [ ] **Step 1: Write failing tests for complete wrapping and newest selection**

```ts
expect(buildActivityBlocks(longCommandSnapshot, 44)[0]?.lines.join("\n"))
  .toContain("src/tui/app.tsx:57:3 Live error");
expect(buildActivityBlocks(longCommandSnapshot, 44)[0]?.lines.join("\n")).not.toContain("…");
store.selectLastFiltered();
expect(store.snapshot().selectedCall?.callId).toBe("c");
expect(buildSearchCounter(filteredSnapshot)).toBe("3 / 7");
```

- [ ] **Step 2: Verify RED**

Run: `bun test test/session/store.test.ts test/tui/view-model.test.ts`
Expected: FAIL because `selectLastFiltered`, `buildActivityBlocks`, and `buildSearchCounter` do not exist.

- [ ] **Step 3: Implement minimal wrapping model**

Use hard/word wrapping that preserves every character and applies a four-space continuation indent. Activity blocks expose all rendered lines with no ellipsis; search denominator counts rows eligible under the active status filter before the query is applied.

- [ ] **Step 4: Verify GREEN**

Run: `bun test test/session/store.test.ts test/tui/view-model.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/store.ts src/tui/view-model.ts test/session/store.test.ts test/tui/view-model.test.ts
git commit -m "feat: wrap tui activity without truncation"
```
### Task 2: Stable terminal follow behavior and multi-line feed

**Files:**
- Create: `src/tui/activity-feed.tsx`
- Modify: `src/tui/interaction.ts`
- Create: `test/tui/activity-feed.test.tsx`
- Modify: `test/tui/interaction.test.ts`

**Interfaces:**
- Produces: `FollowState { following: boolean; pendingNew: number }`.
- Produces: `updateFollowState(state, event): FollowState`, where events are `user-away`, `new-call`, and `resume`.
- Extends `TuiAction` with `jump-end` and `toggle-arguments`; `End` maps to `jump-end`, `a` maps to `toggle-arguments`.
- Produces: `<ActivityFeed blocks follow onScrollRef?>` rendering every logical block line with one shared selection background.

- [ ] **Step 1: Write failing follow/feed tests**

```ts
expect(updateFollowState({ following: true, pendingNew: 0 }, "user-away"))
  .toEqual({ following: false, pendingNew: 0 });
expect(updateFollowState({ following: false, pendingNew: 1 }, "new-call"))
  .toEqual({ following: false, pendingNew: 2 });
expect(actionForKey({ name: "end" })).toBe("jump-end");
```
The render test creates one selected block with three continuation lines and asserts every span carrying those lines has `TUI_THEME.selectedBackground`.

- [ ] **Step 2: Verify RED**

Run: `bun test test/tui/interaction.test.ts test/tui/activity-feed.test.tsx`
Expected: FAIL on missing follow interfaces/component.

- [ ] **Step 3: Implement follow reducer and feed**

`ActivityFeed` uses OpenTUI `<scrollbox stickyScroll={follow.following} stickyStart="bottom">`. Logical blocks render as vertical boxes; every line receives the same selected background. The component itself does not own MCP state.

- [ ] **Step 4: Verify GREEN**

Run: `bun test test/tui/interaction.test.ts test/tui/activity-feed.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/activity-feed.tsx src/tui/interaction.ts test/tui/activity-feed.test.tsx test/tui/interaction.test.ts
git commit -m "feat: add stable tui activity follow"
```

### Task 3: Tool-aware detail and expandable arguments

**Files:**
- Create: `src/tui/tool-detail.ts`
- Modify: `src/tui/detail-view.tsx`
- Create: `test/tui/tool-detail.test.ts`
- Modify: `test/tui/detail-view.test.tsx`
**Interfaces:**
- Produces: `ToolDetailPresentation { kind: "generic" | "read" | "write" | "edit" | "process"; path?; mode?; content?; filetype?; diffLines?; fields }`.
- Produces: `buildToolDetailPresentation(row): ToolDetailPresentation` without mutating `row.args` or `row.resultText`.
- `read_file` maps `isUrl`, `offset`, and `length` to readable fields and extracts the file body from recognized Desktop Commander result wrappers; unknown wrapper shapes fall back to the raw result.
- `CallDetailView` gains `argumentsExpanded: boolean`; collapsed arguments show at most three lines plus `[a expand]`, expanded arguments show all lines.

- [ ] **Step 1: Write failing tool-detail tests**

```ts
const write = buildToolDetailPresentation(writeFileRow);
expect(write).toMatchObject({ kind: "write", path: "/project/src/app.ts", mode: "append" });
expect(write.content).toContain("export function render");
expect(write.filetype).toBe("typescript");
const edit = buildToolDetailPresentation(editBlockRow);
expect(edit.diffLines).toEqual(expect.arrayContaining(["- old value", "+ new value"]));
const read = buildToolDetailPresentation(readFileRow);
expect(read).toMatchObject({ kind: "read", path: "/project/src/app.ts" });
expect(read.fields).toEqual(expect.arrayContaining([
  { label: "Source", value: "Local file" },
  { label: "Range", value: "lines 1–24" },
]));
expect(read.content).toContain("export const app");
```

Render tests verify collapsed raw arguments hide verbose JSON, expanded arguments reveal it, `Content to write` appears for `write_file`, `Changes` appears for `edit_block`, `Command` appears for `start_process`, and `read_file` shows `Reading…` while running then `Content` when complete.

- [ ] **Step 2: Verify RED**

Run: `bun test test/tui/tool-detail.test.ts test/tui/detail-view.test.tsx`
Expected: FAIL because specialized presentation and argument state do not exist.

- [ ] **Step 3: Implement pure extraction and detail composition**

Infer content filetype from the destination path using the existing output-renderer inference. Render write content through `<code>` when supported and plain wrapped text otherwise. Render edit diff lines semantically (`-` danger, `+` success, context muted). Result remains the largest flex region.
- [ ] **Step 4: Verify GREEN**

Run: `bun test test/tui/tool-detail.test.ts test/tui/detail-view.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/tool-detail.ts src/tui/detail-view.tsx test/tui/tool-detail.test.ts test/tui/detail-view.test.tsx
git commit -m "feat: add tool-aware tui detail"
```

### Task 4: Compose refined UX in the app

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/theme.ts`
- Modify: `test/tui/app.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes `buildActivityBlocks`, `buildSearchCounter`, `ActivityFeed`, follow reducer, and `CallDetailView(argumentsExpanded)`.
- Local signals: `mode`, `follow`, `argumentsExpanded`, `lastTotalCalls`.
- Incoming call count changes update follow state; when following, call `store.selectLastFiltered()` before refresh. `previous` pauses follow; `jump-end` resumes follow, clears pending count, and selects newest.

- [ ] **Step 1: Write failing app smoke tests**

Smoke frames assert wrapped long command text appears without `…`, search mode includes `3 / 7`, activity footer includes `End latest` only when pending new calls exist, and detail footer advertises `a arguments`.
- [ ] **Step 2: Verify RED**

Run: `bun test test/tui/app.test.tsx`
Expected: FAIL against the current one-line feed/search/footer behavior.

- [ ] **Step 3: Wire refined composition**

Replace the inline activity `scrollbox` with `ActivityFeed`. Keep search as one line with a right-aligned match counter. Reset `argumentsExpanded` when selection/detail changes. Help groups shortcuts under Navigate / Inspect / Filter / Exit while the normal footer remains one concise line.

- [ ] **Step 4: Update README**

Document wrapped activity, bottom-follow behavior, `End`, `a`, `write_file` Content, and `edit_block` Changes.

- [ ] **Step 5: Verify full product**

Run: `bun test && bun run typecheck`.
Then scan: `rg -n 'supabase|RemoteChannel|WebSocket|heartbeat' src` and confirm no forbidden remote-infrastructure imports were introduced.
Expected: all tests pass, typecheck succeeds, architecture boundary remains intact.

- [ ] **Step 6: Live MCP smoke**

Launch the branch TUI and issue real `read_file`, long `start_process`, `write_file` and safe temporary-file `edit_block` calls. Visually confirm complete wrapping, bottom-follow, semantic detail, Content and Changes. Remove the temporary test file afterward.

- [ ] **Step 7: Commit**

```bash
git add src/tui/app.tsx src/tui/theme.ts test/tui/app.test.tsx README.md
git commit -m "feat: refine tui interaction and presentation"
```
