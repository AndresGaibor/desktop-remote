import { expect, test } from "bun:test";
import { selectCliMode } from "../src/cli/mode";

test("TTY defaults to interactive Desktop Commander remote mode", () => {
  expect(selectCliMode({ stdinIsTTY: true, args: [] })).toEqual({
    kind: "interactive",
    desktopCommanderArgs: ["remote", "--persist-session"],
  });
});

test("piped stdin keeps compatibility formatter mode", () => {
  expect(selectCliMode({ stdinIsTTY: false, args: [] })).toEqual({ kind: "pipe" });
});

test("replay loads a JSONL session without spawning Desktop Commander", () => {
  expect(selectCliMode({ stdinIsTTY: true, args: ["replay", "session.jsonl"] })).toEqual({
    kind: "replay",
    file: "session.jsonl",
  });
});

test("interactive mode forwards explicit Desktop Commander arguments", () => {
  expect(selectCliMode({ stdinIsTTY: true, args: ["remote", "--debug"] })).toEqual({
    kind: "interactive",
    desktopCommanderArgs: ["remote", "--debug"],
  });
});

test("daemon subcommand selects daemon mode with default args", () => {
  expect(selectCliMode({ stdinIsTTY: true, args: ["daemon"] })).toEqual({
    kind: "daemon",
    desktopCommanderArgs: ["remote", "--persist-session"],
  });
});

test("daemon subcommand forwards explicit Desktop Commander arguments", () => {
  expect(selectCliMode({ stdinIsTTY: true, args: ["daemon", "remote", "--debug"] })).toEqual({
    kind: "daemon",
    desktopCommanderArgs: ["remote", "--debug"],
  });
});

test("daemon mode works without a TTY for background execution", () => {
  expect(selectCliMode({ stdinIsTTY: false, args: ["daemon"] })).toEqual({
    kind: "daemon",
    desktopCommanderArgs: ["remote", "--persist-session"],
  });
});
