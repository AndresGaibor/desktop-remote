# Install Local Desktop Commander Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Desktop Commander locally and run it without resolving dependencies at every startup.

**Architecture:** `@wonderwhy-er/desktop-commander` becomes a runtime dependency with version range `^0.2.47`. `src/launcher.ts` uses the package's local executable by default and keeps `--cmd` as an explicit process override.

**Tech Stack:** Bun, TypeScript, bun:test, `@wonderwhy-er/desktop-commander`.

## Global Constraints

- Add `@wonderwhy-er/desktop-commander` with exact range `^0.2.47`.
- Do not perform runtime package resolution or installation in `bun run start`.
- Preserve `--cmd` behavior and argument forwarding unchanged.
- `bun install` is the one-time setup and update command.

---

### Task 1: Select the local executable

**Files:**
- Modify: `test/launcher.test.ts`
- Modify: `src/launcher.ts`

**Interfaces:**
- Produces: `getCommandToSpawn(customCmd?: string): string`, returning `customCmd` or `"desktop-commander"`.
- Produces: `getSpawnArgs(customCmd: string | undefined, targetArgs: string[]): string[]`, returning `targetArgs` unchanged.

- [ ] **Step 1: Update the failing default-launcher test**

```ts
test("uses the installed Desktop Commander executable by default", () => {
  expect(getCommandToSpawn()).toBe("desktop-commander");
  expect(getSpawnArgs(undefined, ["remote", "--persist-session"])).toEqual([
    "remote",
    "--persist-session",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/launcher.test.ts`

Expected: FAIL because the default remains `bunx` and prepends package-resolution arguments.

- [ ] **Step 3: Implement local launcher selection**

```ts
export function getCommandToSpawn(customCmd?: string): string {
  return customCmd || "desktop-commander";
}

export function getSpawnArgs(_customCmd: string | undefined, targetArgs: string[]): string[] {
  return targetArgs;
}
```

- [ ] **Step 4: Run the launcher tests**

Run: `bun test test/launcher.test.ts`

Expected: PASS with 2 tests.

### Task 2: Install and document the runtime dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `bin/cli.ts:20`
- Modify: `README.md`

**Interfaces:**
- Consumes: default executable `desktop-commander` from Task 1.
- Produces: a lockfile-resolved local executable available after `bun install`.

- [ ] **Step 1: Add the dependency declaration**

```json
"@wonderwhy-er/desktop-commander": "^0.2.47"
```

Place it in `dependencies` in alphabetical order.

- [ ] **Step 2: Update the custom-command help text**

```ts
.option("--cmd <command>", "Custom command to run instead of the installed desktop-commander executable")
```

- [ ] **Step 3: Update README setup and examples**

Add a one-time setup command:

```bash
bun install
```

Replace the pipe example with:

```bash
desktop-commander remote --persist-session | desktop-remote
```

- [ ] **Step 4: Install and update the lockfile**

Run: `bun install`

Expected: dependency installed locally and `bun.lock` updated. Puppeteer may download its browser during this explicit setup command.

- [ ] **Step 5: Run the full suite**

Run: `bun test`

Expected: PASS with no failures.

- [ ] **Step 6: Confirm startup no longer invokes Bunx**

Run: `bun run start -- --cmd true`

Expected: the displayed command begins with `true remote --persist-session`, exits successfully, and contains no `bunx` resolution output.
