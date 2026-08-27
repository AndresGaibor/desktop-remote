export interface ResponseBudget {
  maxBytes?: number;
  maxItems?: number;
  maxProperties?: number;
  maxStringBytes?: number;
}

export interface BoundedResponse {
  value: unknown;
  truncated: boolean;
  originalBytes: number;
  bytes: number;
}

export const DEFAULT_RESPONSE_BUDGET: Required<ResponseBudget> = {
  maxBytes: 64 * 1024,
  maxItems: 256,
  maxProperties: 128,
  maxStringBytes: 16 * 1024,
};

/**
 * Calcula el tamaño JSON sin serializar de nuevo un payload potencialmente enorme.
 * Se detiene al superar `limit`, que es la ruta usada por el handler MCP.
 */
export function estimateJsonBytes(value: unknown, limit = Number.MAX_SAFE_INTEGER): number {
  const seen = new Set<object>();
  return estimate(value, limit, seen);
}

export function boundResponse(value: unknown, options: ResponseBudget = {}): BoundedResponse {
  const budget = normalizeBudget(options);
  const originalBytes = estimateJsonBytes(value, budget.maxBytes);
  const state: BoundState = { truncated: originalBytes > budget.maxBytes };
  const bounded = boundValue(value, budget, state, new Set<object>());
  const bytes = estimateJsonBytes(bounded);

  return {
    value: bounded,
    truncated: state.truncated || bytes > budget.maxBytes,
    originalBytes,
    bytes,
  };
}

export function serializeResponse(value: unknown, options: ResponseBudget = {}): string {
  const bounded = boundResponse(value, options).value;
  const serialized = JSON.stringify(bounded);
  return serialized === undefined ? "" : serialized;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "…";
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentLimit) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

interface NormalizedBudget {
  maxBytes: number;
  maxItems: number;
  maxProperties: number;
  maxStringBytes: number;
}

interface BoundState {
  truncated: boolean;
}

function normalizeBudget(options: ResponseBudget): NormalizedBudget {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_RESPONSE_BUDGET.maxBytes);
  return {
    maxBytes,
    maxItems: positiveInteger(options.maxItems, DEFAULT_RESPONSE_BUDGET.maxItems),
    maxProperties: positiveInteger(options.maxProperties, DEFAULT_RESPONSE_BUDGET.maxProperties),
    maxStringBytes: Math.min(
      positiveInteger(options.maxStringBytes, DEFAULT_RESPONSE_BUDGET.maxStringBytes),
      Math.max(1, maxBytes - 2),
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundValue(
  value: unknown,
  budget: NormalizedBudget,
  state: BoundState,
  ancestors: Set<object>,
): unknown {
  if (typeof value === "string") {
    const bounded = truncateUtf8(value, budget.maxStringBytes);
    if (bounded !== value) state.truncated = true;
    return bounded;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") {
    state.truncated = true;
    return `${value}n`;
  }
  if (typeof value !== "object") {
    state.truncated = true;
    return String(value);
  }
  if (ancestors.has(value)) {
    state.truncated = true;
    return "[Circular]";
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) return boundArray(value, budget, state, nextAncestors);
  return boundObject(value as Record<string, unknown>, budget, state, nextAncestors);
}

function boundArray(
  value: unknown[],
  budget: NormalizedBudget,
  state: BoundState,
  ancestors: Set<object>,
): unknown[] {
  const result: unknown[] = [];
  const count = Math.min(value.length, budget.maxItems);
  if (value.length > count) state.truncated = true;

  for (let index = 0; index < count; index += 1) {
    const candidate = boundValue(value[index], budget, state, ancestors);
    const next = [...result, candidate];
    if (estimateJsonBytes(next, budget.maxBytes) > budget.maxBytes) {
      state.truncated = true;
      break;
    }
    result.push(candidate);
  }
  return result;
}

function boundObject(
  value: Record<string, unknown>,
  budget: NormalizedBudget,
  state: BoundState,
  ancestors: Set<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = Object.keys(value);
  const count = Math.min(keys.length, budget.maxProperties);
  if (keys.length > count) state.truncated = true;

  for (let index = 0; index < count; index += 1) {
    const key = keys[index]!;
    const candidate = boundValue(value[key], budget, state, ancestors);
    const next = { ...result, [key]: candidate };
    if (estimateJsonBytes(next, budget.maxBytes) > budget.maxBytes) {
      state.truncated = true;
      break;
    }
    result[key] = candidate;
  }
  return result;
}

function estimate(value: unknown, limit: number, seen: Set<object>): number {
  if (typeof value === "string") return Math.min(limit + 1, Buffer.byteLength(value, "utf8") + 2);
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (value === undefined) return 0;
  if (typeof value === "bigint") return Buffer.byteLength(`${value}n`, "utf8") + 2;
  if (typeof value !== "object") return Buffer.byteLength(JSON.stringify(String(value)), "utf8");
  if (seen.has(value)) return 10;
  seen.add(value);

  let total = 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      total += item === undefined ? 4 : estimate(item, Math.max(0, limit - total), seen);
      if (total > limit) {
        seen.delete(value);
        return limit + 1;
      }
      if (index < value.length - 1) total += 1;
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      total += Buffer.byteLength(JSON.stringify(key), "utf8");
      total += 1;
      total += estimate(item, Math.max(0, limit - total), seen);
      if (total > limit) {
        seen.delete(value);
        return limit + 1;
      }
      total += 1;
    }
    if (total > 2) total -= 1;
  }
  seen.delete(value);
  return total;
}
