# Runtime Deploy and Contract Consistency

## Goal

Correct stale launchd definitions and prevent MCP/daemon runtime-contract
mismatches from reaching normal tool execution. Improve `doctor --json` so it
distinguishes the installed build, loaded service, active processes, contract
identity, and historical log warnings.

## Scope

This change is limited to launchd reload semantics, runtime contract identity,
doctor reporting, and production artifact regression coverage. It does not
change `allowedDirectories`, `blockedCommands`, `fileReadLineLimit`, or
`fileWriteLineLimit`. MCP schemas must remain unchanged while validating the
ChatGPT snapshot.

## Design

### Launchd reload

`LaunchdManager.start()` will always perform a real definition reload:

1. `launchctl bootout <service>`, accepting not-loaded/not-found responses.
2. `launchctl bootstrap <domain> <plist>` and fail on other errors.
3. `launchctl enable <service>`.
4. `launchctl kickstart -k <service>`.

The sequence is verified by an injected command runner. A split definition
(`desktop-remote-daemon`) is replaced by a single definition
(`desktop-remote daemon`), and the active mock definition must reflect the new
arguments rather than merely the rewritten plist.

### Runtime contract identity

A shared deterministic identity contains `buildId`, `protocolVersion`, and
`operationContractHash`. The hash is derived from the canonical MCP operation
catalog, including operation names, input/output schemas, and annotations.

The daemon includes this identity in its IPC status response. The MCP-side IPC
client validates it before the first operation. A mismatch prevents execution
and returns an explicit error beginning with:

`RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.`

The mismatch path must not produce a secondary Zod structured-content error.

### Doctor report

`doctor --json` exposes:

- `installedBuild`: `layout`, `installedAt`, `cli`, `daemon`
- `loadedService`: `command`, `args`, `pid`
- `mcp`: `pid`, `executable`, `buildId`
- `daemon`: `pid`, `executable`, `buildId`
- `contract`: `mcpHash`, `daemonHash`, `matches`

Health fails when the loaded service command/arguments differ from the
installed layout, or when MCP and daemon contract hashes differ. Historical
errors are reported as warnings and do not make the report unhealthy when all
active components and contract checks pass.

### Production regression

The artifact gate launches MCP and daemon artifacts from the same build and
executes:

1. `start_process("printf contract-ok")`, validating the structured response.
2. `read_process_output(pid)`, validating the structured response.

Tool catalog presence alone is insufficient for this gate.

## Verification

TDD order is mandatory for each behavior: failing test, minimal
implementation, focused test, full suite, typecheck, and production build.
After deployment, `install` is run once and `doctor --json` verifies the loaded
launchd definition and matching runtime contract. ChatGPT schema refresh and
comparison are observational only and occur after the runtime is stable.
