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
