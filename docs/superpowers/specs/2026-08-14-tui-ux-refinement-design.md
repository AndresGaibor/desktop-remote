# Desktop Remote TUI UX Refinement

## Goal

Refine the current OpenCode-style TUI without changing its core architecture or making it visually busy. The second pass focuses on readability, information density, predictable terminal behavior, and reducing information loss.

The runtime boundary remains unchanged: Desktop Commander owns authentication, remote connectivity, MCP routing, tool execution and persistence. `desktop-remote` only supervises the local official process, derives local presentation state, and renders the TUI.

## Design direction

Use an **equilibrated terminal feed**:

- compact enough to scan quickly;
- richer hierarchy than the current version;
- semantic color only where it helps;
- no permanent dashboard panels;
- no important content hidden behind ellipsis;
- detail remains a full focused view opened with `Enter`.

The existing single-column structure is preserved.

## Main activity feed

Tool calls are presented chronologically with the newest calls at the bottom, following normal terminal/log reading direction.
Each call is a small multi-line block rather than a forced one-line row:

```text
› ✓ start_process
    printf 'PASS tui-live.test.ts\nwarning src/tui/app.tsx:42:7 ...'
    completed · 1.6s
```

The first line contains selection, status glyph and tool name. The target/command/path starts on the next line with a consistent indent. Status metadata such as duration or `running` is secondary and aligned with the target block.

### No truncation of important content

Paths, commands and targets must not use `…` merely because the terminal is narrow. They wrap naturally onto following lines while preserving indentation.

The selected background/accent covers the complete visual block, including wrapped continuation lines. This makes a long selected call visually coherent.

Very large raw results do not render inline in the activity list; they remain in the focused detail view. The activity feed shows only the identifying target and concise status metadata.

## Feed follow behavior

When the user is following the newest call, incoming calls keep the view pinned to the bottom automatically.
If the user moves upward to inspect earlier activity, auto-follow pauses immediately and selection/scroll position remain stable while new events arrive.

While paused, the footer or activity header shows a compact indicator such as `↓ 3 new`. Returning to the newest item with `End` resumes follow mode and clears the pending count.

`j/k` and `↑/↓` continue to move selection one call at a time. Navigation operates on logical calls, not wrapped screen lines.

## Selection and color

The selected background becomes slightly darker and less saturated than the current cyan block so long wrapped calls remain readable.

Status remains the strongest color signal:

- green: completed / PASS;
- amber: running / warning;
- red: failed / error;
- cyan: focus, paths/locations and interactive accents;
- gray: metadata and secondary hints.

Tool families may receive only a very subtle secondary cue if it improves scanning. No unique icon vocabulary is introduced for every MCP tool.

## Focused detail view

`Enter` opens the selected call as a full focused detail screen. `Esc` returns directly to the activity feed with selection preserved.
The detail header is compact: tool name, semantic status, duration and shortened call ID. Repeated labels are avoided.

### Arguments

Arguments are collapsed by default when verbose. The collapsed presentation shows the most useful 2–3 lines and an explicit hint such as `[a expand]`.

Pressing `a` toggles expanded/collapsed arguments without leaving the detail view. Expanded arguments are complete and scroll/wrap rather than truncate.

Short argument sets that already fit comfortably may render fully without requiring expansion.

### Result and error

Result/error is the visual priority and receives the remaining vertical space. It scrolls independently when needed.

- source code and JSON use OpenTUI Tree-sitter highlighting;
- lint/test output keeps semantic PASS/FAIL/warning/error/location colors;
- shell/plain output remains readable monospaced text;
- line numbers are shown where they improve source/diagnostic comprehension, not universally.

No renderer may modify the underlying event payload.

## Search

`/` opens a one-line live search surface. The query stays visible while typing and results update immediately.
Search shows a compact match counter, for example `3 / 7`, without introducing a large panel. `Enter` accepts the current search and returns to activity; `Esc` closes search predictably and preserves the current query/filter state unless explicitly cleared by the user.

The active status filter remains visible beside `Tool calls` only when it is not `all`, for example `Tool calls · failed`.

## Help and footer

The help overlay becomes smaller and grouped by intent rather than a flat list:

- Navigate: `↑/↓`, `j/k`, `End`;
- Inspect: `Enter`, `a`, `Esc`;
- Filter: `/`, `f`;
- Exit: `Ctrl+C`.

The footer is contextual. It shows only shortcuts relevant to the current mode and may temporarily replace low-value hints with `↓ N new` while auto-follow is paused.

No instruction should be repeated simultaneously in both footer and overlay unless needed for an active temporary state.

## Responsive behavior

The information hierarchy is identical at all widths. Narrow terminals wrap content more often instead of truncating it.

Long call blocks may consume multiple rows; selection and scrolling still operate by logical call. The detail view replaces activity rather than introducing a side panel.

At very small heights, optional contextual summary content is removed before primary activity, footer, or detail result content.
## Component boundaries

The refinement should improve local UI boundaries instead of growing `app.tsx` further.

- `view-model.ts`: logical call presentation, wrapped block data and counts;
- `interaction.ts`: mode transitions, follow-mode actions and detail argument toggle actions;
- `detail-view.tsx`: focused detail composition only;
- `theme.ts`: semantic colors/styles;
- `app.tsx`: screen composition, store coordination and keyboard wiring.

Follow state and pending-new-call count are local presentation state. They do not belong in `DesktopCommanderRuntime` and must not change remote protocol behavior.

## Error handling

A failed MCP call is rendered as normal activity with red status and its error available in detail. Rendering failures must fall back to plain text rather than hiding call data.

If a target cannot be classified for highlighting, the UI uses the plain renderer. Long/unusual Unicode content must wrap without throwing or corrupting selection state.

## Testing

Development remains test-first. Tests must cover logical behavior rather than relying only on screenshots.
Required coverage:

- wrapped activity blocks preserve complete targets without ellipsis;
- navigation and selection operate by logical calls despite multi-line rendering;
- selected styling covers continuation lines;
- follow mode stays pinned only while the user remains at newest activity;
- moving away pauses follow and increments the pending-new count;
- `End` resumes follow and clears the pending count;
- arguments collapse/expand with `a` and never lose data;
- search reports live match counts;
- contextual footer/help text matches the current mode;
- code/JSON and diagnostics retain syntax/semantic highlighting;
- existing runtime, parser, replay, JSONL, pipe and graceful-shutdown tests remain green.
## Tool-aware detail presentation

Known MCP tools receive specialized detail layouts instead of always exposing raw argument JSON.

For `write_file`, the detail view shows destination path, write mode, and a dedicated `Content` section containing the complete text being written. Content uses syntax highlighting inferred from the destination extension and scrolls/wraps without ellipsis.

For `edit_block`, the detail view shows the target path and a readable change preview. Text replacements render as a compact diff with removed content prefixed by `-` and replacement content prefixed by `+`; unchanged context remains muted when useful.

For `read_file`, the path/range remains concise metadata and the returned file content remains the primary result. For `start_process`, the command is visually separated from process output so the user can distinguish what was executed from what it produced.
Specialized argument content is available as soon as the `tool.started` event arrives. A running `write_file` or `edit_block` can therefore be opened immediately to inspect what is being written or changed before completion.

Unknown tools keep the generic argument/result renderer, so specialized presentation never blocks support for newly added Desktop Commander tools.

Additional tests cover:

- `write_file` extracts path, mode and complete content without losing lines;
- `edit_block` produces a readable removed/added diff from its arguments;
- specialized content is available for running calls before a result exists;
- unknown tools fall back to generic arguments and result rendering.

## Non-goals

This pass does not add a command palette, mouse-first navigation, custom themes, remote protocol changes, multi-device management, new authentication behavior, or a unique icon for every MCP tool.
## Success criteria

A long `start_process` command is readable in full from the activity feed without entering detail or seeing `…`. Incoming calls behave like a stable terminal feed: they auto-follow only when appropriate and never pull the user away from older activity being inspected.

The focused detail gives more vertical space to the result than to arguments, while complete arguments remain one keypress away. `write_file` shows the exact content being written, and `edit_block` shows a readable change diff instead of opaque raw JSON.

Search, filters, help and status remain discoverable without permanently consuming screen space. The resulting interface should feel denser and more polished than the current version while preserving its low-noise OpenCode-style hierarchy.
