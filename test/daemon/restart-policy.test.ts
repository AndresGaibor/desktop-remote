import { describe, expect, test } from "bun:test";
import {
  DEGRADED_AFTER_FAILURES,
  DEGRADED_RETRY_MS,
  HEALTHY_RESET_MS,
  RestartPolicy,
} from "../../src/daemon/restart-policy";

describe("RestartPolicy", () => {
  test("uses the approved bounded restart delay sequence", () => {
    const policy = new RestartPolicy();
    const delays = Array.from({ length: 6 }, () => policy.nextAfterExit(1_000).delayMs);
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);
  });

  test("enters degraded mode after ten consecutive unstable exits", () => {
    const policy = new RestartPolicy();
    let decision;
    for (let index = 0; index < DEGRADED_AFTER_FAILURES; index += 1) {
      decision = policy.nextAfterExit(1_000);
    }
    expect(decision).toEqual({
      delayMs: DEGRADED_RETRY_MS,
      degraded: true,
      consecutiveFailures: DEGRADED_AFTER_FAILURES,
    });
    expect(policy.nextAfterExit(1_000).delayMs).toBe(DEGRADED_RETRY_MS);
  });

  test("a healthy run resets the backoff sequence", () => {
    const policy = new RestartPolicy();
    policy.nextAfterExit(1_000);
    policy.nextAfterExit(1_000);

    expect(policy.nextAfterExit(HEALTHY_RESET_MS)).toEqual({
      delayMs: 1_000,
      degraded: false,
      consecutiveFailures: 1,
    });
    expect(policy.nextAfterExit(1_000).delayMs).toBe(2_000);
  });

  test("reset returns the policy to its initial state", () => {
    const policy = new RestartPolicy();
    for (let index = 0; index < DEGRADED_AFTER_FAILURES; index += 1) {
      policy.nextAfterExit(1_000);
    }
    policy.reset();
    expect(policy.snapshot()).toEqual({ consecutiveFailures: 0, degraded: false });
    expect(policy.nextAfterExit(1_000).delayMs).toBe(1_000);
  });
});