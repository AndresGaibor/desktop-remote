import { describe, expect, test } from "bun:test";
import {
  actionForKey,
  transitionMode,
  updateFollowState,
  type TuiMode,
} from "../../src/tui/interaction";

describe("TUI keyboard interaction model", () => {
  test("maps navigation and surfaces from key events", () => {
    expect(actionForKey({ name: "down" })).toBe("next");
    expect(actionForKey({ name: "j" })).toBe("next");
    expect(actionForKey({ name: "up" })).toBe("previous");
    expect(actionForKey({ name: "k" })).toBe("previous");
    expect(actionForKey({ name: "return" })).toBe("open-detail");
    expect(actionForKey({ sequence: "/" })).toBe("open-search");
    expect(actionForKey({ sequence: "?" })).toBe("toggle-help");
    expect(actionForKey({ name: "f" })).toBe("cycle-filter");
    expect(actionForKey({ name: "end" })).toBe("jump-end");
    expect(actionForKey({ name: "a" })).toBe("toggle-arguments");
    expect(actionForKey({ name: "c", ctrl: true })).toBe("quit");
  });

  test("Escape closes temporary modes back to activity", () => {
    for (const mode of ["detail", "search", "help"] satisfies TuiMode[]) {
      expect(transitionMode(mode, "escape", true)).toBe("activity");
    }
  });

  test("opens detail only when a selection exists", () => {
    expect(transitionMode("activity", "open-detail", true)).toBe("detail");
    expect(transitionMode("activity", "open-detail", false)).toBe("activity");
  });

  test("opens search and help from activity", () => {
    expect(transitionMode("activity", "open-search", true)).toBe("search");
    expect(transitionMode("activity", "toggle-help", true)).toBe("help");
    expect(transitionMode("help", "toggle-help", true)).toBe("activity");
  });

  test("unknown keys do not change mode", () => {
    expect(actionForKey({ name: "x" })).toBe("none");
    expect(transitionMode("activity", "none", true)).toBe("activity");
  });
});


test("follow state pauses, counts new calls, and resumes", () => {
  const paused = updateFollowState({ following: true, pendingNew: 0 }, "user-away");
  expect(paused).toEqual({ following: false, pendingNew: 0 });
  const pending = updateFollowState(paused, "new-call");
  expect(updateFollowState(pending, "new-call")).toEqual({ following: false, pendingNew: 2 });
  expect(updateFollowState({ following: false, pendingNew: 4 }, "resume"))
    .toEqual({ following: true, pendingNew: 0 });
});
