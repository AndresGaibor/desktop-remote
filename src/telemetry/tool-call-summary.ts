import { createHash } from "node:crypto";
import { redactText, redactValue } from "../logging/redactor";

const MAX_INLINE_TEXT_BYTES = 768;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 48;
const MAX_DEPTH = 6;
const CONTENT_KEYS = new Set(["content", "oldstring", "newstring", "body", "payload", "input"]);

export interface ToolCallSummary {
  arguments: unknown;
  result?: unknown;
  error?: string;
}

export function summarizeToolCall(
  _name: string,
  input: unknown,
  result?: unknown,
  error?: string,
): ToolCallSummary {
  return {
    arguments: summarizeValue(redactValue(input), "", 0),
    ...(result === undefined ? {} : { result: summarizeValue(redactValue(result), "result", 0) }),
    ...(error === undefined ? {} : { error: boundedText(redactText(error)) }),
  };
}

function summarizeValue(value: unknown, key: string, depth: number): unknown {
  if (depth >= MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const bytes = Buffer.byteLength(value);
    if (CONTENT_KEYS.has(normalizedKey) || bytes > MAX_INLINE_TEXT_BYTES) return textSummary(value);
    return boundedText(value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, key, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_ITEMS:${value.length - MAX_ARRAY_ITEMS}]`);
    return items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    const summarized = Object.fromEntries(entries.map(([name, nested]) => [name, summarizeValue(nested, name, depth + 1)]));
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) summarized.__truncatedKeys = true;
    return summarized;
  }
  return value;
}

function textSummary(value: string): { kind: "text-summary"; bytes: number; sha256: string } {
  return {
    kind: "text-summary",
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value) <= MAX_INLINE_TEXT_BYTES) return value;
  let end = Math.min(value.length, MAX_INLINE_TEXT_BYTES);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > MAX_INLINE_TEXT_BYTES) end -= 1;
  return `${value.slice(0, end)}…`;
}
