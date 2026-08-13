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
]);

export function redactEvent(event: RuntimeEvent): RuntimeEvent {
  return redactValue(event) as RuntimeEvent;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
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

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
