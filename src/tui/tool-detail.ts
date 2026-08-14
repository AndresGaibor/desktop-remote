import type { ToolCallRow } from "../session/types";
import { inferFiletype } from "./output-renderer";

export type ToolDetailKind = "generic" | "read" | "write" | "edit" | "process";

export interface ToolDetailField {
  label: string;
  value: string;
}

export interface ToolDetailPresentation {
  kind: ToolDetailKind;
  path?: string;
  mode?: string;
  content?: string;
  filetype?: string;
  diffLines?: string[];
  fields: ToolDetailField[];
}

export function buildToolDetailPresentation(row: ToolCallRow): ToolDetailPresentation {
  const args = asRecord(row.args);
  if (row.toolName === "read_file") return buildReadPresentation(row, args);
  if (row.toolName === "write_file") return buildWritePresentation(args);
  if (row.toolName === "edit_block") return buildEditPresentation(args);
  if (row.toolName === "start_process") return buildProcessPresentation(args);
  return { kind: "generic", fields: [] };
}

function buildReadPresentation(
  row: ToolCallRow,
  args: Record<string, unknown>,
): ToolDetailPresentation {
  const path = readString(args.path ?? args.filePath);
  const fields: ToolDetailField[] = [{
    label: "Source",
    value: readBoolean(args.isUrl) ? "URL" : "Local file",
  }];
  const range = formatReadRange(readNumber(args.offset), readNumber(args.length));
  if (range) fields.push({ label: "Range", value: range });
  return {
    kind: "read",
    path,
    content: extractReadContent(row.resultText),
    filetype: inferFiletype(path),
    fields,
  };
}

function buildWritePresentation(args: Record<string, unknown>): ToolDetailPresentation {
  const path = readString(args.path ?? args.file_path);
  const mode = readString(args.mode);
  const content = readString(args.content) ?? "";
  return {
    kind: "write",
    path,
    mode,
    content,
    filetype: inferFiletype(path),
    fields: [],
  };
}

function buildEditPresentation(args: Record<string, unknown>): ToolDetailPresentation {
  const path = readString(args.file_path ?? args.path);
  const oldText = readString(args.old_string) ?? "";
  const newText = readString(args.new_string) ?? "";
  return {
    kind: "edit",
    path,
    diffLines: [
      ...prefixLines(oldText, "- "),
      ...prefixLines(newText, "+ "),
    ],
    fields: [],
  };
}

function buildProcessPresentation(args: Record<string, unknown>): ToolDetailPresentation {
  const shell = readString(args.shell);
  const timeout = readNumber(args.timeout_ms);
  const fields: ToolDetailField[] = [];
  if (shell) fields.push({ label: "Shell", value: shell });
  if (timeout !== undefined) fields.push({ label: "Timeout", value: formatTimeout(timeout) });
  return {
    kind: "process",
    content: readString(args.command) ?? "",
    fields,
  };
}

function prefixLines(value: string, prefix: string): string[] {
  if (!value) return [];
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatTimeout(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatReadRange(offset?: number, length?: number): string | undefined {
  if (offset !== undefined && offset < 0) return `last ${Math.abs(offset)} lines`;
  const start = (offset ?? 0) + 1;
  if (length !== undefined && length > 0) return `lines ${start}–${start + length - 1}`;
  if (offset !== undefined) return `from line ${start}`;
  return undefined;
}
function extractReadContent(result?: string): string | undefined {
  if (result === undefined) return undefined;
  const lines = result.split(/\r?\n/);
  const wrapped = /^\[Reading\b.*\]$/.test(lines[0]?.trim() ?? "");
  if (!wrapped) return result;

  let start = 1;
  if (lines[start] === "") start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1] === "") end -= 1;
  if (/^\[executed on device:.*\]$/.test(lines[end - 1]?.trim() ?? "")) {
    end -= 1;
    while (end > start && lines[end - 1] === "") end -= 1;
  }
  return lines.slice(start, end).join("\n");
}