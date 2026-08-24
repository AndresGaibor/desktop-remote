import { expect, test } from "bun:test";
import { getCommandToSpawn, getSpawnArgs } from "../src/launcher";

test("uses the desktop-remote executable by default", () => {
  expect(getCommandToSpawn()).toBe("desktop-remote");
  expect(getSpawnArgs(undefined, ["remote", "--persist-session"])).toEqual([
    "remote",
    "--persist-session",
  ]);
});

test("preserves a custom command and its arguments", () => {
  expect(getCommandToSpawn("custom-runner")).toBe("custom-runner");
  expect(getSpawnArgs("custom-runner", ["remote"])).toEqual(["remote"]);
});
