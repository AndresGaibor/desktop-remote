import { describe, expect, test } from "bun:test";
import {
  actionForKey,
  registerActivityClick,
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
    expect(actionForKey({ name: "left" })).toBe("back");
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


test("follow state freezes only for detail, counts new calls, and resumes", () => {
  const frozen = updateFollowState({ following: true, pendingNew: 0 }, "freeze");
  expect(frozen).toEqual({ following: false, pendingNew: 0 });
  const pending = updateFollowState(frozen, "new-call");
  expect(updateFollowState(pending, "new-call")).toEqual({ following: false, pendingNew: 2 });
  expect(updateFollowState({ following: false, pendingNew: 4 }, "resume"))
    .toEqual({ following: true, pendingNew: 0 });
});

test("same-call second click inside threshold opens detail", () => {
  const first = registerActivityClick(undefined, "call-1", 1_000);
  expect(first.open).toBe(false);
  expect(registerActivityClick(first.state, "call-1", 1_200).open).toBe(true);
  expect(registerActivityClick(first.state, "call-2", 1_200).open).toBe(false);
  expect(registerActivityClick(first.state, "call-1", 1_500).open).toBe(false);
});

test("back action closes detail like Escape", () => {
  expect(transitionMode("detail", "back", true)).toBe("activity");
});
