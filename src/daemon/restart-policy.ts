export const HEALTHY_RESET_MS = 5 * 60 * 1_000;
export const DEGRADED_AFTER_FAILURES = 10;
export const DEGRADED_RETRY_MS = 5 * 60 * 1_000;

const NORMAL_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

export interface RestartDecision {
  delayMs: number;
  degraded: boolean;
  consecutiveFailures: number;
}

export class RestartPolicy {
  private consecutiveFailures = 0;
  private degraded = false;

  nextAfterExit(runDurationMs: number): RestartDecision {
    if (runDurationMs >= HEALTHY_RESET_MS) this.reset();

    this.consecutiveFailures += 1;
    this.degraded = this.consecutiveFailures >= DEGRADED_AFTER_FAILURES;
    const delayMs = this.degraded
      ? DEGRADED_RETRY_MS
      : NORMAL_DELAYS_MS[Math.min(this.consecutiveFailures - 1, NORMAL_DELAYS_MS.length - 1)]!;

    return { delayMs, degraded: this.degraded, consecutiveFailures: this.consecutiveFailures };
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.degraded = false;
  }

  snapshot(): { consecutiveFailures: number; degraded: boolean } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      degraded: this.degraded,
    };
  }
}
