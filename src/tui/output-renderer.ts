import type { ToolCallRow } from "../session/types";

export type DetailKind = "code" | "json" | "diagnostics" | "shell" | "plain";
export type DetailSource = "result" | "error" | "empty";
export type DiagnosticRole = "pass" | "fail" | "error" | "warning" | "location" | "summary" | "normal";

export interface DiagnosticLine {
  text: string;
  role: DiagnosticRole;
}

export interface DetailContent {
  kind: DetailKind;
  content: string;
  source: DetailSource;
  filetype?: string;
  lines: DiagnosticLine[];
}

export function inferFiletype(path?: string): string | undefined {
  if (!path) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "typescriptreact";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx")) return "javascriptreact";
  if (/\.(?:js|mjs|cjs)$/.test(lower)) return "javascript";
  if (/\.(?:md|mdx)$/.test(lower)) return "markdown";
  if (lower.endsWith(".json")) return "javascript";
  if (lower.endsWith(".zig")) return "zig";
  return undefined;
}
export function classifyDiagnosticLine(text: string): DiagnosticLine {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const passCount = lower.match(/^(\d+)\s+pass(?:ed)?\b/);
  const failCount = lower.match(/^(\d+)\s+fail(?:ed)?\b/);

  if (/^pass\b/.test(lower) || trimmed.startsWith("✓") || passCount) {
    return { text, role: "pass" };
  }
  if (/^fail\b/.test(lower) || trimmed.startsWith("✕")) {
    return { text, role: "fail" };
  }
  if (failCount) {
    return { text, role: Number(failCount[1]) === 0 ? "pass" : "fail" };
  }
  if (/\berror\b/i.test(text)) return { text, role: "error" };
  if (/\bwarn(?:ing)?\b/i.test(text)) return { text, role: "warning" };
  if (/\S+\.[a-z0-9]+:\d+(?::\d+)?/i.test(text)) return { text, role: "location" };
  if (/\bran\s+\d+\s+tests?\b|tests?\s+across|expect\(\)\s+calls/i.test(text)) {
    return { text, role: "summary" };
  }
  return { text, role: "normal" };
}

export function classifyDetailContent(row: ToolCallRow): DetailContent {
  const source: DetailSource = row.resultText !== undefined
    ? "result"
    : row.error !== undefined ? "error" : "empty";
  const content = row.resultText ?? row.error ?? "";
  const lines = content.split(/\r?\n/).map(classifyDiagnosticLine);
  if (looksDiagnostic(lines)) {
    return { kind: "diagnostics", content, source, lines };
  }

  if (source === "error") {
    return { kind: "plain", content, source, lines };
  }

  const path = readPath(row.args);
  if (path?.toLowerCase().endsWith(".json") || looksLikeJson(content)) {
    return { kind: "json", content, source, filetype: "javascript", lines };
  }

  const filetype = inferFiletype(path);
  if (filetype) {
    return { kind: "code", content, source, filetype, lines };
  }

  if (isShellLike(row)) {
    return { kind: "shell", content, source, lines };
  }

  return { kind: "plain", content, source, lines };
}

function looksDiagnostic(lines: DiagnosticLine[]): boolean {
  const strong = lines.filter((line) => ["error", "warning", "fail"].includes(line.role));
  if (strong.length > 0) return true;
  const signal = lines.filter((line) => ["pass", "summary", "location"].includes(line.role));
  return signal.length >= 2;
}
function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function readPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args.path ?? args.filePath;
  return typeof value === "string" ? value : undefined;
}

function isShellLike(row: ToolCallRow): boolean {
  if (["start_process", "read_process_output", "interact_with_process"].includes(row.toolName)) {
    return true;
  }
  return isRecord(row.args) && typeof row.args.command === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
