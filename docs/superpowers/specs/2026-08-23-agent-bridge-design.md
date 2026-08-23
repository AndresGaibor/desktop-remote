# Desktop Remote Agent Bridge Design

Date: 2026-08-23

## Goals

- Keep Desktop Commander unmodified and upgradable.
- Add a local/remote multi-agent message bus with delivery, acknowledgement, replies, priorities, TTL, and bounded history.
- Add a Context Hub that exposes project instructions, AGENTS.md-family files, skills, runtime state, and pending coordination context on demand.
- Add an external interceptor/bridge layer that preserves Desktop Commander tools and augments them with `desktop_remote.*` capabilities.
- Add safe automatic device verification through locally discovered CDP endpoints when the Desktop Commander verification page is already authenticated.
- Improve TUI observability so current work, messages, context, and useful activity summaries matter more than a constant retained-call count.

## Non-goals

- No fork or source patch of `@wonderwhy-er/desktop-commander`.
- No automatic Google/Gmail login, account selection, passwords, OTP, MFA, or unrelated OAuth consent.
- No general chat platform, attachments, arbitrary channels, or unbounded message retention.
- No LLM embedded in the daemon for skill selection.

## Architecture

`desktop-remote` remains the long-lived daemon and owns five isolated subsystems: `AgentBridge`, `MessageBus`, `ContextHub`, `DeviceAuthVerifier`, and TUI projection. Desktop Commander remains a supervised child/dependency. Integration is through public/importable package surfaces or a compatibility wrapper, never `node_modules` edits.

### AgentBridge

`AgentBridge` is the boundary between external agents and Desktop Commander. It keeps existing Desktop Commander tools available, adds `desktop_remote.*` tools, injects pending human/agent messages at the next interceptable interaction, and emits canonical audit events.

If the installed Desktop Commander version cannot externally register extra tools, a versioned adapter imports its integration API and delegates calls while leaving the package untouched.

### Message Bus

Messages are addressable to logical identities such as `human:andres`, `agent:desktop`, `agent:codex`, `agent:reviewer`, `agent:*`, and `device:<name>/<agent>`.

Required fields: `id`, `from`, `to`, `createdAt`, `priority`, `body`, `status`. Optional fields: `replyTo`, `expiresAt`, `metadata`.

Lifecycle:

```text
queued -> delivered -> acknowledged
                  -> failed
                  -> expired
```

Delivery is at-least-once at the bus boundary with message IDs and deduplication. Agent presentation avoids replaying a delivered message on every tool call. Messages remain short and bounded.

Local clients use the existing daemon IPC socket. Cross-device traffic uses a separate authenticated `RemoteBridgeTransport`. The local socket is never exposed directly to the network. Device identity determines sender identity; clients cannot impersonate human identities.

Initial tools:

- `desktop_remote.send_message`
- `desktop_remote.reply`
- `desktop_remote.list_messages`
- `desktop_remote.get_message`
- `desktop_remote.ack_message`
- `desktop_remote.get_context`
- `desktop_remote.get_instructions`
- `desktop_remote.get_project_instructions`
- `desktop_remote.list_skills`
- `desktop_remote.read_skill`
- `desktop_remote.get_agent_status`

Delegation/orchestration is intentionally deferred.

### Context Hub

`ContextHub` resolves instructions from general to specific scopes, including `~/.config/desktop-remote/AGENTS.md`, ancestor/repository `AGENTS.md` files, and compatible instruction filenames such as `CLAUDE.md`, `GEMINI.md`, and `CODEX.md`. More-specific scope wins on conflicts; `desktop-remote` does not reinterpret higher-level policy hierarchy.

Skills are discovered from configured roots including `~/.config/desktop-remote/skills`, `<repo>/.agents/skills`, and `<repo>/.codex/skills`. The default context contains only metadata/index entries; full skill text is returned only by `read_skill`. Relevance hints are deterministic/lightweight and never execute a skill automatically.

Dynamic context may include device, OS, repository root, cwd, branch, dirty/clean state, daemon/Desktop Commander state, active process IDs, pending messages, active instruction files, and available/relevant skills. Expensive probes use TTL caches. File refresh uses mtimes or narrowly scoped watchers rather than recursive whole-filesystem watching.

All returned context is size-bounded and secret-redacted before persistence or agent exposure.

### Automatic Device Verification via CDP

When Desktop Commander enters an authentication-required state, `DeviceAuthVerifier` obtains the expected verification URL/code from supervised child events and asks `BrowserDiscovery` for local CDP endpoints.

`BrowserDiscovery` does not assume browser or port. It first inspects running Chrome/Chromium/Brave-family process arguments for `--remote-debugging-port` or supported debugging transports, then checks configured/last-known loopback endpoints, then optionally performs a bounded loopback-only port scan. Successful endpoints are validated with CDP metadata and remembered per device as hints, not hard requirements.

Multiple browsers/ports may coexist. The verifier inspects candidate tabs and acts only when all checks match:

- Desktop Commander origin/path.
- Verification-page semantics.
- Displayed code equals the child request code.
- An already-authenticated page state is present.

It never stores the displayed email address.

Allowed automation is limited to inspecting the Desktop Commander verification page, matching the code, detecting an existing authenticated state, clicking `Verify Device`, and observing completion.

Forbidden automation includes Google/Gmail login, account selection, credentials, OTP/MFA, unrelated consent, and arbitrary-site interaction. If authentication is required, automation stops and surfaces a human-action state.

CDP is loopback-only by default. A verifier failure is isolated and cannot terminate the daemon or Desktop Commander child.

### TUI projection

The activity view keeps bounded retained calls but replaces the fixed `50 calls` emphasis with useful state: online/working state, pending/unread messages, current activity, success/failure/running summary, project/context indicators, and recent coordination. Repeated polling calls may be grouped while preserving drill-down to individual calls.

Rows keep aligned tool/duration/time columns. Day separators, relative age in detail views, process/session grouping, and message delivery states are projections derived from canonical events rather than duplicated state.

## Persistence and limits

- Message body <= 16 KiB; metadata <= 8 KiB by default.
- Message and audit histories are bounded on disk and in memory with atomic/append-safe persistence consistent with the existing history subsystem.
- Auth requests and verification codes are ephemeral and are not persisted after completion; audit history records only sanitized outcomes.
- Existing tool-call retention remains bounded; its exact numeric cap is an implementation detail, not the primary TUI metric.

## Security model

Authority order remains user/platform policy -> `desktop-remote` security -> agent permissions -> project instructions -> skills. Markdown context cannot grant permissions.

Remote transport authenticates devices and enforces sender/destination ACLs, frame/size limits, TTL, and deduplication. Secrets matching token/password/Authorization patterns are redacted before logging, storage, or context delivery.

## Failure handling

Each subsystem fails independently. Message persistence failure leaves the daemon queryable and surfaces degraded state. Remote transport loss queues eligible messages locally until TTL/limits are reached. Invalid/corrupt context files are skipped with diagnostics. CDP discovery or page-shape changes never trigger generic browser automation.

## Testing strategy

Use TDD. Unit tests cover message lifecycle/routing/deduplication, identity/ACL enforcement, context precedence, skill discovery/redaction, CDP endpoint discovery, and strict verification predicates.

Integration tests cover Desktop Commander adapter compatibility, IPC message injection, multi-agent replies, restart persistence, cross-device transport boundaries, and authentication-required/no-login behavior. Existing daemon fault/soak/release gates remain mandatory.

## Delivery phases

1. Core `MessageBus` + local IPC tools + TUI message projection.
2. `ContextHub` + instruction/skill discovery and `desktop_remote` context tools.
3. `AgentBridge` adapter that augments Desktop Commander without package modification and injects pending messages.
4. `DeviceAuthVerifier` + `BrowserDiscovery` with Mac Brave and Debian Chrome fixtures/tests.
5. Authenticated `RemoteBridgeTransport` for cross-device agent messaging.
6. TUI activity grouping/summary polish and full soak/release verification.

## Compatibility

Desktop Commander remains pinned/validated through an adapter compatibility contract. Version-specific behavior is isolated behind that adapter so upgrading Desktop Commander requires adapter tests rather than changes throughout the daemon.

## Acceptance criteria

- Existing Desktop Commander tools continue to work unchanged.
- A human or authorized local agent can send a message and the target agent receives it automatically on the next interceptable interaction.
- Agents can send/reply/ack messages, including across devices once `RemoteBridgeTransport` is enabled.
- Project instructions and skills are discoverable without stuffing full contents into every interaction.
- Mac Brave and Debian Chrome CDP ports are discovered dynamically; no fixed browser/port assumption is required.
- Auto-verification clicks only a matching, already-authenticated Desktop Commander verification page and never performs login.
- No Desktop Commander source/package files are modified.
- Daemon stays bounded, restartable, observable, and passes existing release/soak gates.
