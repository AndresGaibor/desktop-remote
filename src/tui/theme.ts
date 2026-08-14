export type SemanticTone =
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "muted"
  | "default";

export const TUI_THEME = {
  accent: "#38bdf8",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#fb7185",
  muted: "#64748b",
  text: "#e2e8f0",
  selectedBackground: "#0c4a6e",
  panelBackground: "#111827",
} as const;

export function toneColor(tone: SemanticTone): string {
  if (tone === "default") return TUI_THEME.text;
  return TUI_THEME[tone];
}
