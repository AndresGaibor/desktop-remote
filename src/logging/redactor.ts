import type { RuntimeEvent } from "../runtime/events";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "password",
  "passwd",
  "secret",
  "apikey",
  "code",
  "verificationcode",
  "usercode",
  "authcode",
]);

const QUERY_PARAMETER_PATTERN = /([?&])([^=&#\s]+)=([^&#\s]*)/g;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/gi;
const GITHUB_PAT_PATTERN = /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi;

export function redactEvent(event: RuntimeEvent): RuntimeEvent {
  return redactValue(event) as RuntimeEvent;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactValue(nested),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEYS.has(normalized);
}

export function redactText(value: string): string {
  return value
    .replace(QUERY_PARAMETER_PATTERN, (match, separator: string, key: string) =>
      isSensitiveKey(key) ? `${separator}${key}=[REDACTED]` : match,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(GITHUB_PAT_PATTERN, "[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED]")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
