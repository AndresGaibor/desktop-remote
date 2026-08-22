import { readFile } from "node:fs/promises";

/**
 * Cross-runtime utilities shared by Bun and Node.js.
 *
 * Timers stay referenced by default so daemon restart backoff keeps Node alive.
 * Callers such as the disposable TUI may pass an AbortSignal to cancel waits.
 */
export function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
