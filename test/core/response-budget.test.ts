import { describe, expect, test } from "bun:test";
import { boundResponse, estimateJsonBytes, serializeResponse } from "../../src/core/response-budget";

describe("response budget", () => {
  test("bounds nested structured content by UTF-8 bytes and items", () => {
    const original = {
      payload: "é".repeat(10_000),
      items: Array.from({ length: 10_000 }, (_, index) => ({ index, value: "item" })),
    };

    const bounded = boundResponse(original, { maxBytes: 1_024, maxItems: 8, maxStringBytes: 128 });

    expect(bounded.truncated).toBe(true);
    expect(estimateJsonBytes(bounded.value)).toBeLessThanOrEqual(1_024);
    expect((bounded.value as { items: unknown[] }).items.length).toBeLessThanOrEqual(8);
    const serialized = serializeResponse(original, { maxBytes: 1_024, maxItems: 8, maxStringBytes: 128 });
    expect(serialized.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(1_024);
  });
});
