# Desktop Remote OpenCode-Style TUI Redesign

## Goal

Make `desktop-remote` feel closer to OpenCode: fast to scan, low-noise, keyboard-first, and visually focused on the current MCP activity instead of looking like a dashboard with large empty panels.

The redesign changes only local presentation and interaction. Desktop Commander continues to own authentication, remote connectivity, device registration, heartbeat, MCP routing, and tool execution.

## Design principles

- Tool activity is the primary content.
- Empty space should feel intentional, not boxed-off.
- Details appear contextually instead of occupying half the screen permanently.
- Color is semantic and restrained.
- Important errors, warnings, paths, durations, and statuses must be scannable without reading every line.
- The interface remains usable entirely from the keyboard.
## Main layout

The default view is a single dominant activity list rather than a permanent 55/45 split.

```text
 desktop-remote                         ● online · Andress-MacBook-Air-2

 Tool calls

 › ✓ read_file       src/tui/app.tsx                 82ms
   ✓ list_sessions                                  14ms
   ● start_process    bun test                     running
   ✕ read_file        /missing/file                  21ms

 ─────────────────────────────────────────────────────────

 Selected call summary / contextual detail

 ↑↓ navigate   enter details   / search   f filter   ? help
```

When no tool calls exist, the content area shows a compact empty state such as `Waiting for tool calls…` plus one short hint. No large bordered empty panes are rendered.
## Color and highlighting

Use semantic accents rather than coloring every element:

- cyan: product accent, selected row, interactive focus;
- green: completed/success/PASS;
- amber: running, authentication required, warnings;
- red: failed calls, errors, FAIL;
- muted gray: call IDs, metadata, secondary labels and hints;
- normal foreground: tool names, paths, commands and primary result text.

The selected row must be unmistakable through a visible accent/background in addition to the `›` marker. Status must remain understandable without color through glyphs and text.

Detail output gets content-aware highlighting. JSON and source code use OpenTUI syntax rendering where a language/file type can be inferred. Test/linter output gets semantic highlighting for PASS/FAIL, error/warning labels, file paths, `line:column`, counts and summaries. Plain text remains plain instead of forcing a highlighter.
## Interaction model

The activity list always keeps keyboard focus unless a temporary surface is open.

- `↑/↓` or `j/k`: move selection.
- `Enter`: open a focused detail view for the selected call; `Esc` returns to activity.
- `/`: open a one-line search surface; submit or `Esc` returns to activity.
- `f`: cycle `all → running → completed → failed`; the active filter is shown compactly beside `Tool calls`.
- `?`: open a small help overlay instead of reserving permanent vertical space.
- `Ctrl+C`: graceful shutdown through `DesktopCommanderRuntime.stop()`.

The footer shows only the highest-value shortcuts. Additional controls live in `?` help.
## Detail presentation

The default screen shows only a short contextual summary below the activity list when useful. Full arguments/results do not permanently consume half of a wide terminal.

Pressing `Enter` opens the selected call as the main content view. Its header contains status, tool name, duration and a shortened call ID. Arguments are shown compactly, followed by the result or error. Long content scrolls independently.

Renderer selection is content-aware:

- source/file content: syntax-highlighted code when language is known;
- JSON: structured/syntax-highlighted JSON;
- test/lint output: semantic line highlighting;
- shell/process output: monospaced text with error/warning emphasis;
- unknown content: readable plain-text fallback.

The renderer must never alter or reinterpret the underlying event data.
## Responsive behavior

The same information hierarchy is kept at every width.

- Wide terminals: activity remains the dominant single column; contextual summary may use the lower portion of the screen.
- Medium terminals: summary is reduced and long targets are truncated more aggressively.
- Narrow terminals: only activity is shown by default; `Enter` replaces it with the full detail view until `Esc`.

There is no automatic permanent side-by-side detail pane based solely on width. This avoids the large empty right panel visible in the current version.

## Authentication and connection states

Connection state is condensed into the top-right header (`● online`, `● connecting`, `! auth`, `✕ offline`). Authentication remains a temporary high-priority surface showing the official Desktop Commander URL/code. It does not become a separate connection implementation.
## Testing

Tests cover the visual model rather than terminal snapshots alone:

- activity rows expose semantic status and target information;
- empty state is concise;
- selected row remains visually distinguishable without relying on color alone;
- detail renderer classification chooses code, JSON, lint/test, shell or plain text correctly;
- narrow/wide layouts keep the same hierarchy;
- search/filter/help/detail transitions preserve selection and store state;
- OpenTUI `testRender` smoke tests verify the main activity and detail screens render without orphan text nodes.

Existing runtime, parser, JSONL, replay and pipe compatibility tests remain unchanged unless the UI contract requires an explicit update.