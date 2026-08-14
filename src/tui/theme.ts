import { SyntaxStyle } from "@opentui/core";

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
  selectedBackground: "#082f49",
  panelBackground: "#111827",
} as const;

export const TUI_SYNTAX_STYLE = SyntaxStyle.fromStyles({
  keyword: { fg: "#c084fc", bold: true },
  string: { fg: "#86efac" },
  number: { fg: "#fbbf24" },
  type: { fg: "#67e8f9" },
  function: { fg: "#7dd3fc" },
  method: { fg: "#7dd3fc" },
  property: { fg: "#93c5fd" },
  variable: { fg: TUI_THEME.text },
  comment: { fg: TUI_THEME.muted, italic: true },
  operator: { fg: "#f0abfc" },
  punctuation: { fg: "#94a3b8" },
  constant: { fg: "#fbbf24" },
  constructor: { fg: "#67e8f9" },
});

export function toneColor(tone: SemanticTone): string {
  if (tone === "default") return TUI_THEME.text;
  return TUI_THEME[tone];
}
