# Agent Message Bus Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded persistent local multi-agent MessageBus, expose it through the existing daemon IPC socket, and let the TUI compose and observe human/agent messages without modifying Desktop Commander.

**Architecture:** Message state stays separate from `RuntimeSessionSnapshot`. A daemon-owned `MessageBus` handles validation, lifecycle, persistence and subscriptions; IPC adds explicit message request/command frames; the visual client synchronizes those frames into a TUI-only `MessageUiStore`. Phase 1 deliberately stops before AgentBridge automatic injection and cross-device transport.

**Tech Stack:** Bun, TypeScript, Node `net` IPC, JSONL persistence, SolidJS + OpenTUI, bun:test.

**Spec:** `docs/superpowers/specs/2026-08-23-agent-bridge-design.md`

## Global Constraints

- Do not modify files inside `node_modules/@wonderwhy-er/desktop-commander`.
- Local clients use the existing daemon Unix socket; never expose that socket to the network.
- Message body maximum is 16 KiB; metadata maximum is 8 KiB.
- Message histories remain bounded in memory and on disk; persistence uses mode `0600` and parent directories `0700`.
- Device/client identity determines `from`; a client cannot claim `human:andres` or another protected identity in the payload.
- Phase 1 supports `queued`, `delivered`, `acknowledged`, `failed`, and `expired`, but does not yet deliver messages into Desktop Commander prompts/tools.
- Phase 1 adds local send/reply/list/get/ack primitives and TUI observability; `RemoteBridgeTransport`, ContextHub, AgentBridge and CDP verification remain later plans.
- TDD is mandatory: each behavior starts with a failing test, then minimal implementation, then focused/full verification.

---
## File Structure

- Create `src/messages/types.ts`: message IDs, identities, statuses, priorities, command inputs, snapshots and event types.
- Create `src/messages/bounds.ts`: body/metadata limits, TTL normalization, text/metadata bounding helpers.
- Create `src/messages/message-bus.ts`: in-memory lifecycle, routing queries, deduplication and listeners.
- Create `src/messages/message-history-store.ts`: bounded JSONL persistence and compact checkpoint loading.
- Create `src/messages/ui-store.ts`: TUI-local message snapshot, selection and unread/pending counts.
- Modify `src/platform/paths.ts`: add `messageHistoryPath`.
- Modify `test/helpers/desktop-remote-paths.ts`: provide the new test path.
- Modify `src/daemon/run-daemon.ts`: construct/load/close MessageBus persistence and pass it to IPC.
- Modify `src/daemon/ipc-server.ts`: authorize and route message commands/queries separately from visual lease logic.
- Modify `src/ipc/protocol.ts`: add bounded message request/response/event frames.
- Modify `src/client/ipc-client.ts`: request message snapshots and invoke message commands.
- Modify `src/client/session-source.ts`: synchronize runtime events and message events into their separate stores.
- Modify `src/tui/interaction.ts`: add message-compose and message-pane actions/modes.
- Modify `src/tui/app.tsx`: show useful activity/message summary, message list and composer.
- Modify `src/tui/run-tui.tsx`: wire `MessageUiStore` to the app lifecycle.
- Add focused tests under `test/messages/` and extend existing IPC/client/TUI/integration tests.

---

### Task 1: Message domain, bounds, and in-memory lifecycle

**Files:**
- Create: `src/messages/types.ts`
- Create: `src/messages/bounds.ts`
- Create: `src/messages/message-bus.ts`
- Test: `test/messages/message-bus.test.ts`
**Interfaces:**
- Produces `AgentIdentity = string`, `MessagePriority = "low" | "normal" | "high"`, `MessageStatus = "queued" | "delivered" | "acknowledged" | "failed" | "expired"`.
- Produces `AgentMessage`, `SendMessageInput`, `ReplyMessageInput`, `MessageQuery`, `MessageBusSnapshot`, `MessageEvent`.
- Produces `MessageBus.send(sender, input)`, `reply(sender, input)`, `ack(actor, id)`, `markDelivered(id)`, `get(id)`, `list(query?)`, `snapshot()`, `onEvent(listener)`.

- [ ] **Step 1: Write failing lifecycle/validation tests**

```ts
const bus = new MessageBus({ now: () => 1_000, idFactory: () => "msg-1" });
const sent = bus.send("human:andres", { to: "agent:desktop", body: "Revisa logs", priority: "high" });
expect(sent).toMatchObject({ id: "msg-1", from: "human:andres", to: "agent:desktop", status: "queued" });
expect(() => bus.send("human:andres", { to: "agent:desktop", body: "x".repeat(16 * 1024 + 1) })).toThrow(/16 KiB/);
bus.markDelivered("msg-1");
bus.ack("agent:desktop", "msg-1");
expect(bus.get("msg-1")?.status).toBe("acknowledged");
```

Also test: duplicate explicit IDs are rejected; reply inherits a valid `replyTo`; only recipient/broadcast recipient may acknowledge; expired messages become `expired`; snapshots are newest-bounded; event listeners receive immutable copies.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test test/messages/message-bus.test.ts`
Expected: FAIL because `src/messages/*` does not exist.

- [ ] **Step 3: Implement the minimal message types and bounds**
```ts
export const MESSAGE_BODY_MAX_BYTES = 16 * 1024;
export const MESSAGE_METADATA_MAX_BYTES = 8 * 1024;
export const MESSAGE_HISTORY_LIMIT = 200;

export interface AgentMessage {
  id: string;
  from: AgentIdentity;
  to: AgentIdentity;
  body: string;
  priority: MessagePriority;
  status: MessageStatus;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  expiresAt?: number;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}
```

Use UTF-8 byte length, not JS character count. Clone metadata/messages at API boundaries and reject empty `to`/body values.

- [ ] **Step 4: Implement `MessageBus` lifecycle and routing**

Store messages in insertion order with a `Map<string, AgentMessage>` plus an ID order array. Before reads/mutations, expire due messages using `now()`. `list({ to, from, status, limit })` filters without exposing mutable references. Broadcast destination `agent:*` is readable/acknowledgeable by `agent:*` recipients but must not mutate sender identity.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `bun test test/messages/message-bus.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/messages test/messages/message-bus.test.ts
git commit -m "feat: add local agent message bus"
```

---

### Task 2: Bounded message persistence

**Files:**
- Create: `src/messages/message-history-store.ts`
- Modify: `src/platform/paths.ts`
- Modify: `test/helpers/desktop-remote-paths.ts`
- Test: `test/messages/message-history-store.test.ts`
- Test: `test/platform/paths.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`, `MessageBusSnapshot`, `MessageBus.restore(snapshot)`.
- Produces: `MessageHistoryStore.loadInto(bus)`, `append(event, snapshot)`, `compact(snapshot)`, `drain()`, `sizeBytes()`.
- Produces path field `DesktopRemotePaths.messageHistoryPath`.

- [ ] **Step 1: Write failing persistence tests**

```ts
const store = new MessageHistoryStore({ path, maxBytes: 8_192, compactAtBytes: 6_000 });
const bus = new MessageBus({ now: () => 100, idFactory: () => "m1" });
const message = bus.send("human:andres", { to: "agent:desktop", body: "hello" });
await store.append({ type: "message.created", message }, bus.snapshot());
const restored = new MessageBus();
await store.loadInto(restored);
expect(restored.get("m1")?.body).toBe("hello");
```
Also test: corrupt suffix is ignored with one warning; checkpoint compaction preserves only bounded newest messages; file mode is `0600`; parent directories remain private; metadata/body pass through existing redaction before persistence.

- [ ] **Step 2: Run persistence/path tests and verify RED**

Run: `bun test test/messages/message-history-store.test.ts test/platform/paths.test.ts`
Expected: FAIL because `messageHistoryPath` and `MessageHistoryStore` are missing.

- [ ] **Step 3: Add the message history path**

In `commonPaths()` return:

```ts
messageHistoryPath: join(appSupportDir, "messages.jsonl"),
```

Update `DesktopRemotePaths` and `makeTestPaths()` with the same field.

- [ ] **Step 4: Implement append/checkpoint persistence**

Mirror `HistoryStore`'s queued-write, atomic temp-file rename, corruption handling and permission strategy, but persist `MessageEvent` plus compact `MessageBusSnapshot`. Redact with `redactValue()` before writing. Never persist future AgentBridge auth data in this file.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `bun test test/messages/message-history-store.test.ts test/platform/paths.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/messages/message-history-store.ts src/platform/paths.ts test/helpers/desktop-remote-paths.ts test/messages/message-history-store.test.ts test/platform/paths.test.ts
git commit -m "feat: persist agent messages"
```

---

### Task 3: Local IPC message API with identity enforcement

**Files:**
- Modify: `src/ipc/protocol.ts`
- Modify: `src/daemon/ipc-server.ts`
- Test: `test/ipc/protocol.test.ts`
- Test: `test/daemon/ipc-server.test.ts`

**Interfaces:**
- Consumes: daemon-owned `MessageBus`.
- Extends hello client modes to `"visual" | "admin" | "agent"` and assigns server-side identity from configuration, never from a message payload.
- Produces request frames `messages.list`, `message.get`, `message.send`, `message.reply`, `message.ack`.
- Produces response/event frames `messages.snapshot`, `message.result`, `message.event`.

- [ ] **Step 1: Write failing protocol parser tests**

```ts
expect(parseClientMessage({
  protocolVersion: 1,
  type: "message.send",
  requestId: "r1",
  to: "agent:desktop",
  body: "check logs",
  priority: "high",
})).toMatchObject({ type: "message.send", requestId: "r1" });
```
Test body/metadata frame limits and malformed priorities/destinations. The wire payload never accepts `from`.

- [ ] **Step 2: Write failing daemon routing/identity tests**

Connect a visual client, send a message, then assert the bus records `from: "human:local"`. Connect an agent client with `agentName: "codex"` and assert the server normalizes it to `agent:codex`. Reject empty/unsafe agent names and any attempted `human:*` identity field.

```ts
send(agent.socket, { type: "hello", client: "agent", agentName: "codex", protocolVersion: 1 });
send(agent.socket, { type: "message.send", requestId: "r1", to: "agent:desktop", body: "done", protocolVersion: 1 });
expect((await agent.waitFor("message.result"))).toMatchObject({ requestId: "r1", message: { from: "agent:codex" } });
```

- [ ] **Step 3: Run protocol/server tests and verify RED**

Run: `bun test test/ipc/protocol.test.ts test/daemon/ipc-server.test.ts`
Expected: FAIL because message frames and bus routing are not implemented.

- [ ] **Step 4: Extend protocol with bounded message frames**

Keep `PROTOCOL_VERSION = 1` because this is an additive backward-compatible change. Validate `requestId`, `to`, body, priority, IDs and query limits before casting. `encodeFrame()` retains the global 512 KiB ceiling while message-specific limits reject much earlier.

- [ ] **Step 5: Add MessageBus to `DaemonIpcServerOptions`**

`messageBus?: MessageBus` is injected; production always passes one, tests may omit it for old cases. Track `identity?: AgentIdentity` in `ClientState`. Hello assigns `human:local` for visual, `agent:admin` for admin, and `agent:${normalizeAgentName(agentName)}` for agent clients.

- [ ] **Step 6: Route commands and stream message events**
For `message.send/reply/ack/get/list`, require a completed hello and use only `state.identity` as actor/sender. `messages.list` defaults to messages relevant to that identity plus broadcasts. Forward `message.event` only to clients that requested message subscription; do not require or consume the single visual lease for agent/admin messaging. A queued message becomes `delivered` when the server successfully writes it to a subscribed matching recipient, or when a matching recipient explicitly lists/gets it and the response is written. Delivery transition is idempotent and emits one `message.updated` event.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `bun test test/ipc/protocol.test.ts test/daemon/ipc-server.test.ts`
Expected: PASS, including all existing visual lease tests.

- [ ] **Step 8: Commit**

```bash
git add src/ipc/protocol.ts src/daemon/ipc-server.ts test/ipc/protocol.test.ts test/daemon/ipc-server.test.ts
git commit -m "feat: expose message bus over local ipc"
```

---

### Task 4: IPC client API and TUI message synchronization

**Files:**
- Modify: `src/client/ipc-client.ts`
- Modify: `src/client/session-source.ts`
- Create: `src/messages/ui-store.ts`
- Test: `test/client/ipc-client.test.ts`
- Test: `test/client/session-source.test.ts`
- Test: `test/messages/ui-store.test.ts`

**Interfaces:**
- `DesktopRemoteIpcClient.connect(mode, options?)` accepts agent name only when mode is `agent`.
- Produces `listMessages(query?)`, `getMessage(id)`, `sendMessage(input)`, `replyMessage(input)`, `ackMessage(id)`, `subscribeMessages(listener)`.
- Produces `MessageUiStore.replace(snapshot)`, `consume(event)`, `selectMessage(id)`, `snapshot()` with `pending`, `unread`, `queued`, and recent-message views.
- `IpcTuiSessionSource` receives both `SessionStore` and `MessageUiStore`; reconnect resynchronizes both stores before declaring `connected`.

- [ ] **Step 1: Write failing `MessageUiStore` tests**

```ts
const store = new MessageUiStore();
store.replace({ messages: [queued, acknowledged] });
expect(store.snapshot().counts).toMatchObject({ total: 2, queued: 1, acknowledged: 1 });
store.consume({ type: "message.updated", message: { ...queued, status: "delivered" } });
expect(store.snapshot().messages.find((m) => m.id === queued.id)?.status).toBe("delivered");
```

Test bounded replacement, stable selection, newest-first projection, and unread calculation for inbound messages not yet acknowledged.

- [ ] **Step 2: Write failing IPC client request correlation tests**

Issue two concurrent message requests and return responses out of order. Assert each promise resolves by `requestId`, disconnect rejects pending message work, and message-event listeners are isolated from runtime-event listeners.

- [ ] **Step 3: Write failing reconnect synchronization test**

Extend `FakeClient` with `listMessages()` and `subscribeMessages()`. Assert initial connect order is runtime subscribe + message subscribe before snapshots, queued events during synchronization are replayed after both snapshots, and reconnect replaces stale message state.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `bun test test/messages/ui-store.test.ts test/client/ipc-client.test.ts test/client/session-source.test.ts`
Expected: FAIL on missing message APIs/store.
- [ ] **Step 5: Implement pending request maps in `DesktopRemoteIpcClient`**

Use one monotonically increasing request counter and `Map<string, Deferred<...>>` per response shape or a typed shared dispatcher. `message.result` resolves mutations/get; `messages.snapshot` resolves lists. `rejectPending()` must reject status, snapshot, and every message request.

- [ ] **Step 6: Implement independent message subscription**

`subscribeMessages(listener)` sends a dedicated `messages.subscribe` frame once connected. Do not reuse runtime `subscribe`, because runtime streaming remains tied to the visual lease while agent/admin clients must receive message traffic without a visual lease.

- [ ] **Step 7: Implement `MessageUiStore` and dual-store synchronization**

`IpcTuiSessionSource` buffers both `RuntimeEvent[]` and `MessageEvent[]` until runtime snapshot and message snapshot have both arrived. Then replace both stores, replay buffered events in arrival order within each stream, attach disconnect listeners, and refresh once.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `bun test test/messages/ui-store.test.ts test/client/ipc-client.test.ts test/client/session-source.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/client src/messages/ui-store.ts test/client test/messages/ui-store.test.ts
git commit -m "feat: synchronize messages with tui clients"
```

---

### Task 5: Daemon ownership, persistence wiring, and restart recovery

**Files:**
- Modify: `src/daemon/run-daemon.ts`
- Test: `test/daemon/run-daemon.test.ts`
- Test: `test/integration/daemon-client-lifecycle.test.ts`
**Interfaces:**
- `runDaemon()` owns exactly one `MessageBus` and one `MessageHistoryStore` for the daemon lifetime.
- Message lifecycle events are persisted asynchronously without blocking IPC responses; one persistence warning is logged per degraded episode.

- [ ] **Step 1: Write failing daemon wiring tests**

Inject a fake MessageBus/history dependency and assert startup loads message history before IPC starts; shutdown stops IPC before daemon/runtime teardown and drains message persistence before returning.

- [ ] **Step 2: Write failing lifecycle integration test**

Start a real daemon/socket with a fake managed runtime, send `human:local -> agent:desktop`, stop the daemon, restart with the same paths, reconnect and assert `messages.list` returns the queued message exactly once.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `bun test test/daemon/run-daemon.test.ts test/integration/daemon-client-lifecycle.test.ts`
Expected: FAIL because `runDaemon()` does not construct/load/persist MessageBus state.

- [ ] **Step 4: Wire production MessageBus and history**

Construct `MessageBus` and `MessageHistoryStore({ path: paths.messageHistoryPath })`. Load before `ipc.start()`. Subscribe once to MessageBus events and append each event with the current message snapshot. Inject the bus into `DaemonIpcServer`.

- [ ] **Step 5: Make shutdown persistence-safe**

Unsubscribe message persistence after IPC stops accepting new work, await the history write chain/drain method, then stop the Desktop Remote daemon. Keep message-history failures isolated and logged as warnings.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `bun test test/daemon/run-daemon.test.ts test/integration/daemon-client-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add src/daemon/run-daemon.ts test/daemon/run-daemon.test.ts test/integration/daemon-client-lifecycle.test.ts
git commit -m "feat: recover message bus across daemon restarts"
```

---

### Task 6: TUI message pane, composer, and useful top summary

**Files:**
- Modify: `src/tui/interaction.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/run-tui.tsx`
- Modify: `src/tui/view-model.ts`
- Test: `test/tui/interaction.test.ts`
- Test: `test/tui/app.test.tsx`
- Test: `test/tui/view-model.test.ts`
- Test: `test/tui/run-tui.test.ts`

**Interfaces:**
- `DesktopRemoteApp` receives `messageStore`, `messageSnapshot`, and `onSendMessage(input)`.
- Add TUI modes `messages` and `compose-message`.
- Add key `m` to open messages, `n` to compose from message mode, `Esc` to cancel/back, and `Enter` to send the current draft.
- Default compose destination is `agent:desktop`; Phase 1 may edit destination in a small `To:` input but does not add channels/attachments.

- [ ] **Step 1: Write failing interaction tests**
Test `m` opens messages only from activity, `n` opens compose only from messages, `Esc` returns without sending, and normal `Enter` still opens call detail outside compose mode.

- [ ] **Step 2: Write failing view-model summary tests**

```ts
expect(buildTopSummary(sessionSnapshot, messageSnapshot)).toContain("1 running");
expect(buildTopSummary(sessionSnapshot, messageSnapshot)).toContain("2 pending messages");
expect(buildTopSummary(sessionSnapshot, messageSnapshot)).not.toBe("50 calls");
```

The summary should prioritize running count, failures, pending inbound/outbound messages, and connection state. Total retained calls may appear only as secondary detail/filter context.

- [ ] **Step 3: Write failing rendered TUI tests**

Render with queued/delivered messages and assert a `Messages` view shows sender/recipient, compact body preview, priority, delivery state, and relative age. Compose a message to `agent:desktop`, submit, and assert `onSendMessage` receives exactly one bounded input.

- [ ] **Step 4: Run focused TUI tests and verify RED**

Run: `bun test test/tui/interaction.test.ts test/tui/view-model.test.ts test/tui/app.test.tsx test/tui/run-tui.test.ts`
Expected: FAIL because message modes/props are absent.

- [ ] **Step 5: Implement message modes and pure projections**

Keep formatting in `view-model.ts`: `buildTopSummary()`, `buildMessageRows()`, `formatRelativeAge()`. Do not make view-model functions mutate stores or call IPC.

- [ ] **Step 6: Implement the TUI message pane and composer**
Use a simple two-field composer (`To`, `Message`) with default `agent:desktop`. While compose input is focused, printable keys belong to the input and global navigation shortcuts must not fire. After successful send, clear the draft and return to messages; on send failure keep the draft and show a concise error.

- [ ] **Step 7: Wire `runTui()` to the connected IPC client/source**

Extend `TuiSessionSource` with `sendMessage(input: SendMessageInput): Promise<AgentMessage>` and implement it in `IpcTuiSessionSource` by delegating to the currently connected visual IPC client. If disconnected/reconnecting, reject with `Desktop Remote is reconnecting` and preserve the composer draft. Do not construct a second client/socket in the component.

- [ ] **Step 8: Run focused TUI tests and verify GREEN**

Run: `bun test test/tui/interaction.test.ts test/tui/view-model.test.ts test/tui/app.test.tsx test/tui/run-tui.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tui src/client/session-source.ts src/tui/run-tui.tsx test/tui test/client/session-source.test.ts
git commit -m "feat: add agent messaging to tui"
```

---

### Task 7: Phase 1 integration, compatibility, and release gates

**Files:**
- Modify as required by failures only: files touched in Tasks 1-6.
- Test: `test/integration/daemon-client-lifecycle.test.ts`
- Test: `test/daemon/architecture.test.ts`
- Test: `test/build/production-build.test.ts`

**Interfaces:**
- No new production interfaces; this task proves the Phase 1 contract end-to-end.
- [ ] **Step 1: Add an end-to-end local agent messaging test**

Start the daemon with a fake Desktop Commander runtime. Connect one visual client and one `agent:codex` client. Send visual -> `agent:codex`, observe the agent subscription event, reply agent -> `human:local`, acknowledge the reply from the visual client, restart the daemon, and assert both messages retain final states without duplicates.

- [ ] **Step 2: Assert Desktop Commander remains untouched**

Extend `test/daemon/architecture.test.ts` so Phase 1 message modules do not import Desktop Commander internals and no source file under `node_modules/@wonderwhy-er/desktop-commander` is required or modified by the feature.

- [ ] **Step 3: Run all focused Phase 1 tests**

Run: `bun test test/messages test/ipc test/daemon/ipc-server.test.ts test/daemon/run-daemon.test.ts test/client test/tui test/integration/daemon-client-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full release verification**

Run: `bun test`
Expected: all tests PASS.

Run: `bun run typecheck`
Expected: exit 0 with no TypeScript errors.

Run: `bun run build:prod`
Expected: production single-binary build succeeds.

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 5: Run daemon fault/soak gates**
Run: `bun run test:soak`
Expected: completes without leaks/crashes and bounded retained state.

Do not run `test:soak:real` against the live authenticated device until normal gates pass and the execution worker explicitly confirms it will not disrupt the active Desktop Commander transport.

- [ ] **Step 6: Inspect repository state**

Run: `git status --short && git log -7 --oneline`
Expected: only intentional Phase 1 changes, no generated/runtime files, no edits under Desktop Commander dependency.

- [ ] **Step 7: Final commit if integration-only fixes were required**

```bash
git add <only-files-changed-by-this-task>
git commit -m "test: verify local agent messaging lifecycle"
```

If Step 7 has no additional diff, do not create an empty commit.

## Phase 1 Exit Criteria

- TUI can send a bounded local message to `agent:desktop` and observe queued/delivered/acknowledged state.
- A local `agent:<name>` IPC client can send, receive, reply to, list and acknowledge messages without acquiring the visual lease.
- Sender identity comes from the IPC connection mode/normalized agent name, never a `from` field in a send payload.
- Messages survive daemon restarts through bounded redacted JSONL persistence.
- The TUI header emphasizes running/failure/message state rather than always displaying retained `50 calls`.
- Existing Desktop Commander tool execution, daemon supervision, visual lease, reconnect behavior and production build remain green.
- No Desktop Commander package/source modification occurs.
