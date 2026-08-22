import { describe, expect, test } from "bun:test";
import { sleep } from "../../src/platform/runtime";

describe("portable runtime helpers", () => {
  test("sleep resolves after its delay when not cancelled", async () => {
    const started = Date.now();
    await sleep(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  test("sleep can be aborted without waiting for a long retry timer", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleep(30_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(500);
  });
});
