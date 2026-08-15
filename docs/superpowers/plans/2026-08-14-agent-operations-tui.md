# Agent Operations TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Activity always follow/select the newest MCP call, add native mouse selection/double-click inspection, and freeze Detail until Back returns to the latest call.

**Architecture:** Keep `SessionStore` as selection source of truth. Model Activity-vs-Detail follow state explicitly in pure interaction helpers, let `ActivityFeed` own OpenTUI mouse/scroll mechanics, and let `DesktopRemoteApp` coordinate mode transitions without changing the official Desktop Commander process boundary.

**Tech Stack:** Bun, TypeScript, SolidJS, OpenTUI Solid/Core 0.5.3, `bun:test`.

## Global Constraints

- Work directly on `main`, per explicit user instruction; do not create a branch/worktree.
- Preserve official `desktop-commander remote --persist-session`; no second MCP transport or execution layer.
- Activity always resumes live-follow; only Detail freezes inspection.
- No meaningful command/path/content truncation.
- Single click selects; double click or Enter opens Detail.
- `Esc` and `←` leave Detail and jump to latest.
- Use TDD: every production behavior starts with a failing test.

---### Task 1: Live/frozen interaction state

**Files:**
- Modify: `src/tui/interaction.ts`
- Test: `test/tui/interaction.test.ts`

**Interfaces:**
- `TuiAction` adds `back` for left-arrow navigation.
- `FollowEvent` becomes `freeze | new-call | resume`.
- `updateFollowState()` keeps Activity live, counts new starts only while frozen, and clears on resume.
- Add `registerActivityClick(state, callId, nowMs, thresholdMs?)` to distinguish first vs. second click.

- [ ] **Step 1: Write the failing interaction tests**

```ts
expect(actionForKey({ name: "left" })).toBe("back");
const frozen = updateFollowState({ following: true, pendingNew: 0 }, "freeze");
expect(updateFollowState(frozen, "new-call")).toEqual({ following: false, pendingNew: 1 });
expect(updateFollowState({ following: false, pendingNew: 3 }, "resume")).toEqual({ following: true, pendingNew: 0 });
const first = registerActivityClick(undefined, "call-1", 1000);
expect(first.open).toBe(false);
expect(registerActivityClick(first.state, "call-1", 1200).open).toBe(true);
```
- [ ] **Step 2: Run** `bun test test/tui/interaction.test.ts` and confirm failures are caused by missing `back`, `freeze`, and click helper behavior.
- [ ] **Step 3: Implement minimal interaction helpers** without UI dependencies.
- [ ] **Step 4: Run** `bun test test/tui/interaction.test.ts` and confirm green.
- [ ] **Step 5: Commit** `git commit -am "feat: model live and frozen tui interaction"`.

### Task 2: Direct call selection in SessionStore

**Files:**
- Modify: `src/session/store.ts`
- Test: `test/session/store.test.ts`

**Interfaces:**
- Produce `selectCall(callId: string): void`.
- Selection only changes when `callId` exists in the current filtered rows; hidden/unknown IDs do not create invalid selection.

- [ ] **Step 1: Write the failing store tests**

```ts
store.selectCall("call-2");
expect(store.snapshot().selectedCall?.callId).toBe("call-2");
store.setStatusFilter("failed");
const before = store.snapshot().selectedCall?.callId;
store.selectCall("call-2");
expect(store.snapshot().selectedCall?.callId).toBe(before);
```
- [ ] **Step 2: Run** `bun test test/session/store.test.ts` and verify RED.
- [ ] **Step 3: Implement** `SessionStore.selectCall()` using `getFilteredRows()`.
- [ ] **Step 4: Run** the focused store test and verify GREEN.
- [ ] **Step 5: Commit** `git commit -am "feat: select tool calls by id"`.### Task 3: Native mouse activity feed and selected-row scrolling

**Files:**
- Modify: `src/tui/activity-feed.tsx`
- Test: `test/tui/activity-feed.test.tsx`

**Interfaces:**
- `ActivityFeedProps` adds `onSelect(callId)` and `onOpen(callId)` callbacks.
- Each call renders inside one logical `<box id="activity-call-<callId>">` spanning all wrapped lines.
- Keep a typed `ScrollBoxRenderable` ref and call `scrollChildIntoView()` when the selected `callId` changes.
- Use `registerActivityClick()` on left-button mouse-up; first click selects, second same-call click inside threshold opens.

- [ ] **Step 1: Write the failing feed render tests**

```tsx
const selected: string[] = [];
const opened: string[] = [];
const setup = await testRender(() => (
  <ActivityFeed blocks={blocks()} following={true} onSelect={(id) => selected.push(id)} onOpen={(id) => opened.push(id)} />
));
const row = setup.renderer.root.findDescendantById("activity-call-call-2")!;
await createMockMouse(setup.renderer).click(row.screenX + 1, row.screenY);
expect(selected.at(-1)).toBe("call-2");
await createMockMouse(setup.renderer).doubleClick(row.screenX + 1, row.screenY);
expect(opened.at(-1)).toBe("call-2");
```

Add a reactive blocks signal, select/append the final block, render again, and assert the captured frame contains the final call target.
- [ ] **Step 2: Run** `bun test test/tui/activity-feed.test.tsx` and verify the new tests fail for missing callbacks/scroll behavior.
- [ ] **Step 3: Implement minimal feed changes** with native mouse handlers, logical call containers, and selected-child scrolling.
- [ ] **Step 4: Run** focused activity-feed tests and confirm green without regressions in wrapped selection background.
- [ ] **Step 5: Commit** `git commit -am "feat: add mouse navigation to activity feed"`.

### Task 4: App wiring, live latest selection, and frozen Detail

**Files:**
- Modify: `src/tui/app.tsx`
- Test: `test/tui/app.test.tsx`

**Interfaces:**
- Activity never transitions to `following: false` from ↑/↓, click, search, or filter.
- `openDetail(callId?)` selects the requested call, freezes follow state, resets argument expansion, and enters Detail.
- `backToActivity()` selects latest filtered call, resumes follow, clears pending count, refreshes, and enters Activity.
- New call starts while Activity is visible select latest automatically; new starts while Detail is open increment `pendingNew` but do not replace the inspected row.

- [ ] **Step 1: Write the failing app tests**

```ts
expect(footerText("detail", { following: false, pendingNew: 2 })).toContain("Esc/← back");
expect(transitionMode("detail", "back", true)).toBe("activity");
```

In a reactive app harness: open Detail on `call-1`, append `call-2`, refresh snapshot, and assert the Detail frame still contains `call-1` plus `↓ 1 new`; then exercise the exported Back helper/state transition and assert latest selection is `call-2`.
- [ ] **Step 2: Run** `bun test test/tui/app.test.tsx test/tui/interaction.test.ts` and verify RED.
- [ ] **Step 3: Wire ActivityFeed callbacks**, remove `user-away` behavior, freeze follow when opening Detail, and route both `escape` and `back` through `backToActivity()`.
- [ ] **Step 4: Ensure search/filter changes select the latest matching row** and keep Activity live.
- [ ] **Step 5: Run** focused app/interaction tests and verify GREEN.
- [ ] **Step 6: Commit** `git commit -am "feat: keep tui activity pinned to live work"`.### Task 5: Documentation, full verification, and live smoke

**Files:**
- Modify: `README.md`
- Fix formatting only: `docs/superpowers/specs/2026-08-14-agent-operations-tui-design.md`

**Interfaces:**
- README documents live latest selection, single/double click, Detail freeze, `↓ N new`, and `Esc/←` Back.
- Spec gets missing blank lines before section headings; no requirements change.

- [ ] **Step 1: Update README and spec formatting** to match implemented controls exactly.
- [ ] **Step 2: Run** `bun test && bun run typecheck && git diff --check`.
- [ ] **Step 3: Run architecture scan** `rg -n 'supabase|RemoteChannel|WebSocket|heartbeat' src`; expect no matches.
- [ ] **Step 4: Generate live MCP activity** with real `read_file`, safe temporary `write_file`, `edit_block`, and `start_process`; remove the temporary file afterward.
- [ ] **Step 5: Visually verify** newest selection/scrolling, click + double-click Detail, Detail freeze while new calls arrive, and Back with `Esc`/`←`. Automated keyboard injection is not required where macOS Accessibility blocks it.
- [ ] **Step 6: Commit** docs/verification-related tracked changes with `git commit -am "docs: document live agent operations tui"`.

## Final verification

Run from repository root:

```bash
bun test
bun run typecheck
git diff --check
rg -n 'supabase|RemoteChannel|WebSocket|heartbeat' src
```

Expected: all tests pass, TypeScript exits 0, diff-check is clean, architecture scan has no output. Confirm `git status --short` is clean after final commit.