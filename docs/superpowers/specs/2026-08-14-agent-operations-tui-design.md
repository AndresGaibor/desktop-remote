# Agent Operations TUI Design

**Date:** 2026-08-14
**Project:** `desktop-remote`
**Branch:** `main`
**Status:** Approved design

## Goal

Turn the existing TUI into a faster operational console for supervising AI agents that use the official Desktop Commander MCP, while preserving the current process boundary.

The UI should make the newest agent action immediately visible, keep the activity feed pinned to live work, support mouse interaction, and make inspection reversible and predictable.

## Non-goals and architecture boundary

`desktop-remote` remains a local supervisor and observer around the official `desktop-commander remote --persist-session` process.

It will not implement a second MCP transport, remote protocol, authentication channel, Supabase/WebSocket backend, or private Desktop Commander execution layer.

The UI must not pretend it can replay arbitrary MCP calls when the official supervised process does not expose such an execution surface.

Local presentation and interaction may be richer, but MCP transport ownership stays upstream.

## Activity mode

Activity is a live feed ordered oldest to newest, with new calls appended at the bottom.

When Activity is in live-follow mode:

- the newest visible call is selected automatically;
- the scrollbox stays pinned to the bottom;
- a newly started call immediately becomes the selected call;
- completion updates to an existing call do not count as a separate new call;
- `End` explicitly restores the same latest-call state.

The selected call uses a subtle dark-cyan background plus a `›` marker. Status remains primarily communicated by `✓`, `●`, and `✕` with semantic color, so color is never the only state signal.

Short rows stay compact. Long commands, paths, targets, and summaries wrap naturally with continuation indentation. Meaningful information is never replaced with an ellipsis.

The current active filter remains visible near the `Tool calls` heading. Search mode displays the live match position/count, for example `3 / 11`.

The footer is contextual and only shows shortcuts that are useful in the current mode.

## Mouse interaction

OpenTUI native mouse events are used; no terminal-coordinate parsing is implemented by `desktop-remote`.

Each logical activity call has a mouse target covering all wrapped lines in that call.

- Single left click selects the call. Live-follow remains active, so the next newly started call becomes selected automatically.
- Double click opens the selected call in Detail.
- `Enter` continues to open Detail from keyboard selection.
- Mouse wheel scrolling is delegated to the OpenTUI scrollbox.

`End` explicitly scrolls to and selects the newest call.

## Detail mode and inspection freeze

Opening Detail freezes the inspected call. New MCP activity may continue arriving, but it must never replace or navigate away from the call currently being inspected.

While Detail is frozen, a discreet `↓ N new` indicator reports calls that started after inspection began.

`Esc` and the left-arrow key both return to Activity. Returning always:

1. selects the newest call that matches the current filter/search context;
2. scrolls that call into view at the bottom;
3. clears the pending-new counter;
4. re-enables live-follow.

## Detail presentation

Detail remains tool-aware rather than exposing raw serialized arguments as the primary UI.

- `read_file`: path, readable source/range metadata, `Reading…` while running, then syntax-highlighted content when available.
- `write_file`: path, mode, and syntax-highlighted `Content to write` from the call arguments, visible even while running.
- `edit_block`: path plus a readable old/new change view; prefer native OpenTUI diff rendering where practical.
- `start_process`: command/shell metadata plus output/result with diagnostic coloring.
- Unknown tools: generic structured fallback with no data loss.

Arguments stay summarized by default so the result/output remains the visual priority. `a` toggles the complete raw arguments for diagnostics.

Code keeps indentation and uses syntax rendering rather than destructive wrapping where appropriate. Human-readable prose, shell output, diagnostics, paths, and commands may wrap but are not truncated.

## Keyboard behavior

Activity keeps `↑/↓` navigation, `Enter` for Detail, `/` for search, `f` for filter, `?` for help, and `End` for latest.

Detail accepts both `Esc` and `←` as Back. `a` toggles raw arguments. Help and footer copy must advertise the same bindings that are actually active.

Search keeps predictable `Esc` behavior: first exit Search back to Activity without losing the underlying dataset/filter, then normal Activity rules apply.## Expert interaction policy

This pass does not add confirmation dialogs for interactions that are in scope. Selection, navigation, opening details, expanding arguments, filtering, searching, mouse actions, and returning to latest execute immediately.

The user explicitly prefers expert-mode behavior with minimal friction.

This does not authorize inventing unsupported MCP execution. If a future local action such as process termination or command replay is added, it must use an existing official/local execution capability with explicit semantics rather than a hidden second transport.

## State model

The UI should model these concepts explicitly rather than deriving them from incidental scroll position:

- selected logical call id/index;
- newest visible call id/index;
- current mode (`activity`, `search`, `detail`, `help`);
- detail-frozen call id;
- count of calls started since Detail was opened;
- current filter and search query/match position.

Activity selection follows newest-call starts automatically. Detail selection is immutable until Back.

The scrollbox should use native sticky-bottom/`scrollChildIntoView` behavior where possible. Selection state remains the source of truth; raw terminal row offsets must not become application state.

## Testing strategy

Implementation follows TDD with pure interaction/state helpers tested separately from OpenTUI rendering.

Required coverage:

- newest started call becomes selected in Activity;
- Activity scrolls newest selection into view automatically;
- clicking a row selects that logical call;
- double click opens Detail for that call;
- Detail remains frozen while later calls arrive;
- pending-new count grows only for newly started calls;
- `Esc` and `←` both leave Detail and jump to latest;
- wrapped multi-line rows preserve complete content;
- filters/search preserve predictable latest selection;
- contextual footer/help stay consistent with key bindings.

Mouse behavior should use OpenTUI's test mouse utilities where stable. Existing keyboard-hook runner limitations should continue to be handled with pure interaction reducer tests rather than fragile synthetic input tests.

A final live MCP smoke test must generate real `read_file`, `write_file`, `edit_block`, and `start_process` activity and visually confirm auto-follow, click/detail behavior, and Back navigation.

## Acceptance criteria

The default Activity experience always follows and selects the newest MCP call without manual intervention. A user can select with the mouse, open with double click or `Enter`, inspect without being interrupted, and return with either `Esc` or `←` directly to the newest live call. No meaningful call information is truncated, and the official Desktop Commander process boundary remains unchanged.