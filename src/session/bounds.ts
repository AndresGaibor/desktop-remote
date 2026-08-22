import type { RuntimeEvent } from "../runtime/events";

export const SESSION_HISTORY_LIMIT = 50;
export const ARGUMENT_MAX_BYTES = 64 * 1024;
export const METADATA_MAX_BYTES = 32 * 1024;
export const RESULT_MAX_BYTES = 256 * 1024;
export const ERROR_MAX_BYTES = 32 * 1024;
export const CONTROL_TEXT_MAX_BYTES = 8 * 1024;
export const RUNTIME_LOG_MAX_BYTES = 64 * 1024;

export interface TruncatedValue {
  __desktopRemoteTruncated: true;
  originalBytes: number;
  preview: string;
}

export function boundText(value: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maxBytes) return value;

  const marker = `\n… [truncated: ${originalBytes} bytes] …\n`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) return takeUtf8Head(marker, maxBytes);

  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available / 2);
  const tailBudget = Math.floor(available / 2);
  return `${takeUtf8Head(value, headBudget)}${marker}${takeUtf8Tail(value, tailBudget)}`;
}

export function boundUnknown(value: unknown, maxBytes: number): unknown {
  const serialized = safeSerialize(value);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxBytes) return value;

  let previewBudget = Math.max(0, maxBytes - 256);
  while (previewBudget > 0) {
    const candidate: TruncatedValue = {
      __desktopRemoteTruncated: true,
      originalBytes,
      preview: boundText(serialized, previewBudget),
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) return candidate;
    previewBudget = Math.floor(previewBudget * 0.8);
  }
  return { __desktopRemoteTruncated: true, originalBytes, preview: "" } satisfies TruncatedValue;
}

export function boundRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  switch (event.type) {
    case "tool.started":
      return {
        ...event,
        callId: boundText(event.callId, CONTROL_TEXT_MAX_BYTES),
        toolName: boundText(event.toolName, CONTROL_TEXT_MAX_BYTES),
        args: boundUnknown(event.args, ARGUMENT_MAX_BYTES),
        metadata: boundUnknown(event.metadata, METADATA_MAX_BYTES),
      };
    case "tool.completed":
      return { ...event, resultText: boundText(event.resultText, RESULT_MAX_BYTES) };
    case "tool.failed":
      return { ...event, error: boundText(event.error, ERROR_MAX_BYTES) };
    case "auth.required":
      return {
        ...event,
        url: boundText(event.url, CONTROL_TEXT_MAX_BYTES),
        code: boundText(event.code, CONTROL_TEXT_MAX_BYTES),
        expiresIn: boundText(event.expiresIn, CONTROL_TEXT_MAX_BYTES),
      };
    case "device.ready":
      return {
        ...event,
        user: boundText(event.user, CONTROL_TEXT_MAX_BYTES),
        deviceId: boundText(event.deviceId, CONTROL_TEXT_MAX_BYTES),
        deviceName: boundText(event.deviceName, CONTROL_TEXT_MAX_BYTES),
      };
    case "runtime.log":
      return { ...event, message: boundText(event.message, RUNTIME_LOG_MAX_BYTES) };
    case "runtime.error":
      return { ...event, message: boundText(event.message, RUNTIME_LOG_MAX_BYTES) };
    default:
      return event;
  }
}

function safeSerialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function takeUtf8Head(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

function takeUtf8Tail(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(value.length - count)) <= maxBytes) low = count;
    else high = count - 1;
  }
  return value.slice(value.length - low);
}
