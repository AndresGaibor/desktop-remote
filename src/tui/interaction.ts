export type TuiMode = "activity" | "detail" | "search" | "help";
export type TuiAction =
  | "next"
  | "previous"
  | "open-detail"
  | "open-search"
  | "toggle-help"
  | "cycle-filter"
  | "jump-end"
  | "toggle-arguments"
  | "escape"
  | "quit"
  | "none";

export interface FollowState {
  following: boolean;
  pendingNew: number;
}

export type FollowEvent = "user-away" | "new-call" | "resume";

export interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export function actionForKey(key: KeyLike): TuiAction {
  if (key.ctrl && key.name === "c") return "quit";
  if (key.name === "escape") return "escape";
  if (key.name === "up" || key.name === "k") return "previous";
  if (key.name === "down" || key.name === "j") return "next";
  if (key.name === "end") return "jump-end";
  if (key.name === "return" || key.name === "enter") return "open-detail";
  if (key.sequence === "/" || key.name === "/") return "open-search";
  if (key.sequence === "?" || key.name === "?") return "toggle-help";
  if (key.name === "f") return "cycle-filter";
  if (key.name === "a") return "toggle-arguments";
  return "none";
}

export function updateFollowState(state: FollowState, event: FollowEvent): FollowState {
  if (event === "resume") return { following: true, pendingNew: 0 };
  if (event === "user-away") return { ...state, following: false };
  if (state.following) return state;
  return { following: false, pendingNew: state.pendingNew + 1 };
}

export function transitionMode(
  mode: TuiMode,
  action: TuiAction,
  hasSelection: boolean,
): TuiMode {
  if (action === "escape") return "activity";
  if (action === "open-detail") {
    return mode === "activity" && hasSelection ? "detail" : mode;
  }
  if (action === "open-search") {
    return mode === "activity" ? "search" : mode;
  }
  if (action === "toggle-help") {
    if (mode === "help") return "activity";
    return mode === "activity" ? "help" : mode;
  }
  return mode;
}
