export type TuiMode = "activity" | "detail" | "search" | "help";
export type TuiAction =
  | "next"
  | "previous"
  | "open-detail"
  | "open-search"
  | "toggle-help"
  | "cycle-filter"
  | "escape"
  | "quit"
  | "none";

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
  if (key.name === "return" || key.name === "enter") return "open-detail";
  if (key.sequence === "/" || key.name === "/") return "open-search";
  if (key.sequence === "?" || key.name === "?") return "toggle-help";
  if (key.name === "f") return "cycle-filter";
  return "none";
}

export function transitionMode(
  mode: TuiMode,
  action: TuiAction,
  hasSelection: boolean,
): TuiMode {
  if (action === "escape") return mode === "activity" ? "activity" : "activity";
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
