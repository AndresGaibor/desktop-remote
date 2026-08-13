# Use Bunx for Desktop Commander Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute Desktop Commander through Bun instead of npm so routine startup does not emit npm deprecation warnings.

**Architecture:** Extract the default child-process command selection into a small pure `src/launcher.ts` module. The CLI continues accepting `--cmd` unchanged; when absent, it invokes `bunx -y @wonderwhy-er/desktop-commander@latest` with the selected remote arguments.

**Tech Stack:** Bun, TypeScript, Commander, bun:test.

## Global Constraints

- Preserve `--cmd` behavior and all forwarded Desktop Commander arguments.
- Do not add dependencies.
- Default process launcher must be `bunx`, never `npx`.
- Update README examples to use Bun tooling.

---

### Task 1: Default launcher selection

**Files:**
- Create: `src/launcher.ts`
- Modify: `bin/cli.ts:19,125-129`
- Create: `test/launcher.test.ts`

**Interfaces:**
- Produces: `getCommandToSpawn(customCmd?: string): string`, returning `customCmd` or `"bunx"`.
- Produces: `getSpawnArgs(customCmd: string | undefined, targetArgs: string[]): string[]`, returning `targetArgs` for a custom command or `["-y", "@wonderwhy-er/desktop-commander@latest", ...targetArgs]` by default.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { getCommandToSpawn, getSpawnArgs } from "../src/launcher";

test("uses bunx for the default Desktop Commander invocation", () => {
  expect(getCommandToSpawn()).toBe("bunx");
  expect(getSpawnArgs(undefined, ["remote", "--persist-session"])).toEqual([
    "-y",
    "@wonderwhy-er/desktop-commander@latest",
    "remote",
    "--persist-session",
  ]);
});

test("preserves a custom command and its arguments", () => {
  expect(getCommandToSpawn("custom-runner")).toBe("custom-runner");
  expect(getSpawnArgs("custom-runner", ["remote"])).toEqual(["remote"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli.test.ts`

Expected: FAIL because `getCommandToSpawn` and `getSpawnArgs` are not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
export function getCommandToSpawn(customCmd?: string): string {
  return customCmd || "bunx";
}

export function getSpawnArgs(customCmd: string | undefined, targetArgs: string[]): string[] {
  return customCmd ? targetArgs : ["-y", "@wonderwhy-er/desktop-commander@latest", ...targetArgs];
}
```

Replace the current `cmdToSpawn` and `spawnArgs` assignments with calls to these functions, and change the `--cmd` description to name `bunx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Run the complete suite**

Run: `bun test`

Expected: PASS with no failures.

### Task 2: Documentation

**Files:**
- Modify: `README.md:25`

**Interfaces:**
- Consumes: the default invocation implemented in Task 1.
- Produces: Bun-based pipe example consistent with the CLI.

- [ ] **Step 1: Update the pipe example**

```bash
bunx -y @wonderwhy-er/desktop-commander@latest remote --persist-session | desktop-remote
```

- [ ] **Step 2: Confirm documentation no longer recommends npx**

Run: `rg "npx" README.md bin/cli.ts`

Expected: no matches.

- [ ] **Step 3: Run the complete suite**

Run: `bun test`

Expected: PASS with no failures.
