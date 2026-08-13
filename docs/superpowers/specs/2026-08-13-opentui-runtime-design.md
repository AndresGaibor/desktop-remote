# Desktop Remote OpenTUI Runtime Design

## Goal

Transform `desktop-remote` from a formatted log wrapper into an interactive local TUI and runtime supervisor while continuing to use the official `@wonderwhy-er/desktop-commander` executable and its hosted remote infrastructure.

## Non-negotiable boundary

`desktop-remote` MUST NOT implement, host, or directly depend on Desktop Commander's remote networking infrastructure. The official `desktop-commander remote --persist-session` process remains responsible for authentication, sessions, tokens, heartbeat, Supabase/realtime transport, device routing, MCP tools, and communication with `mcp.desktopcommander.app`.

The wrapper owns only local concerns: child-process lifecycle, parsing upstream output into typed events, local state, TUI rendering, search/filtering, safe local logging, and replay.

## Architecture

```text
@wonderwhy-er/desktop-commander
          |
          v
DesktopCommanderRuntime adapter
          |
          v
typed RuntimeEvent stream
          |
          v
SessionStore
     |         |
     v         v
OpenTUI UI   JSONL log
```

## Runtime boundary

`DesktopCommanderRuntime` spawns the installed `desktop-commander` binary and forwards user-supplied remote arguments unchanged. It does not import `dist/remote-device/*`, `RemoteChannel`, authentication helpers, or Supabase clients from the dependency.

Shutdown is cooperative: the wrapper sends `SIGINT`, waits for the child to finish its own graceful shutdown sequence, then escalates only if it does not exit within a bounded timeout. The terminal renderer is destroyed after the child lifecycle is settled.

## Event model

Raw stdout/stderr lines are converted into discriminated runtime events such as `runtime.log`, `auth.required`, `device.ready`, `tool.started`, `tool.completed`, `tool.failed`, `runtime.exited`, and `runtime.error`.

Tool durations are keyed by `callId`, never by `toolName`, so concurrent calls to the same tool cannot overwrite each other. Upstream text parsing remains isolated behind one parser module and fixture tests document the expected Desktop Commander log contract.

## State and UI

A framework-agnostic `SessionStore` consumes events and exposes connection state, ordered tool calls, selection, query, status filter, and aggregate counts. The OpenTUI/Solid layer renders that state but does not parse logs or own process lifecycle.

The first TUI version contains a header, scrollable timeline, detail pane, footer/status bar, keyboard navigation, search, status filters, expansion/detail selection, and help. It supports responsive single-pane behavior when terminal width is constrained.

## Logging and replay

Optional JSONL logging records typed events rather than ANSI-formatted terminal output. Persistent logs pass through a redactor that removes verification codes, authorization headers, cookies, access tokens, refresh tokens, and common secret-shaped fields before serialization.

`desktop-remote replay <file>` loads a JSONL session without starting Desktop Commander, allowing deterministic debugging and TUI testing.

## Compatibility mode

When stdout is piped, the CLI remains non-interactive and emits a concise line-oriented representation. TUI dependencies are loaded only for an interactive terminal so piping and automated use remain predictable.

## Quality gates

- `bun test` must pass.
- `bun run typecheck` must finish with zero TypeScript errors.
- New domain/runtime behavior is developed test-first.
- Parser fixtures cover representative auth, device, successful tool, failed tool, malformed JSON, and concurrent same-tool calls.
- No code may import Desktop Commander remote internals.
- The dependency remains the owner of remote connectivity.

## Initial implementation scope

This implementation includes typed events, runtime supervision, state store, OpenTUI/Solid main screen, navigation/details/search/filtering/help, JSONL logging/replay, redaction, graceful shutdown, type-safety cleanup, tests, and updated documentation. Multi-device switching, plugins, custom themes, and a full command palette remain future enhancements because they are not required to establish the new architecture.
