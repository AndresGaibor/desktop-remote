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
  | "back"
  | "escape"
  | "quit"
  | "none";

export interface FollowState {
  following: boolean;
  pendingNew: number;
}

export type FollowEvent = "user-away" | "freeze" | "new-call" | "resume";

export interface ActivityClickState {
  callId: string;
  at: number;
}

export interface ActivityClickResult {
  state: ActivityClickState | undefined;
  open: boolean;
}

export interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export function actionForKey(key: KeyLike): TuiAction {
  if (key.ctrl && key.name === "c") return "quit";
  if (key.name === "escape") return "escape";
  if (key.name === "left") return "back";
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
  if (event === "freeze") return { following: false, pendingNew: 0 };
  if (event === "user-away") return state;
  if (state.following) return state;
  return { following: false, pendingNew: state.pendingNew + 1 };
}


export interface FollowTotalUpdate {
  state: FollowState;
  selectNewest: boolean;
}

export function updateFollowForTotalCalls(
  state: FollowState,
  previousTotal: number,
  total: number,
): FollowTotalUpdate {
  if (previousTotal < 0) {
    return { state, selectNewest: total > 0 && state.following };
  }
  if (total <= previousTotal) return { state, selectNewest: false };

  let next = state;
  for (let index = 0; index < total - previousTotal; index += 1) {
    next = updateFollowState(next, "new-call");
  }
  return { state: next, selectNewest: next.following };
}

export function registerActivityClick(
  state: ActivityClickState | undefined,
  callId: string,
  nowMs: number,
  thresholdMs = 350,
): ActivityClickResult {
  const elapsed = state?.callId === callId ? nowMs - state.at : Number.POSITIVE_INFINITY;
  const open = elapsed >= 0 && elapsed <= thresholdMs;
  return {
    state: open ? undefined : { callId, at: nowMs },
    open,
  };
}

export function transitionMode(
  mode: TuiMode,
  action: TuiAction,
  hasSelection: boolean,
): TuiMode {
  if (action === "escape" || action === "back") return "activity";
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
