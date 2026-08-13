import { expect, test } from "bun:test";
import { getCommandToSpawn, getSpawnArgs } from "../src/launcher";

test("uses the installed Desktop Commander executable by default", () => {
  expect(getCommandToSpawn()).toBe("desktop-commander");
  expect(getSpawnArgs(undefined, ["remote", "--persist-session"])).toEqual([
    "remote",
    "--persist-session",
  ]);
});

test("preserves a custom command and its arguments", () => {
  expect(getCommandToSpawn("custom-runner")).toBe("custom-runner");
  expect(getSpawnArgs("custom-runner", ["remote"])).toEqual(["remote"]);
});
