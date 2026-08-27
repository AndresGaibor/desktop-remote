import { describe, expect, test } from "bun:test";
import { createOperationHandler, type McpRequestLogger } from "../../src/mcp/handler";

class MemoryLogger implements McpRequestLogger {
  readonly events: Array<{ level: string; message: string; data?: unknown }> = [];
  info(message: string, data?: unknown): void { this.events.push({ level: "info", message, data }); }
  warn(message: string, data?: unknown): void { this.events.push({ level: "warn", message, data }); }
  error(message: string, data?: unknown): void { this.events.push({ level: "error", message, data }); }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("MCP backpressure / concurrency limit", () => {
  test("hasta maxConcurrentOperations corren en paralelo; las excedentes se encolan", async () => {
    const DURATION = 80;
    const MAX_CONCURRENT = 2;
    const logger = new MemoryLogger();

    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};
    const active: string[] = [];
    const activeSnapshots: number[] = [];

    const executor = {
      execute: async (name: string) => {
        startTimes[name] = Date.now();
        active.push(name);
        activeSnapshots.push(active.length);
        try {
          await new Promise((r) => setTimeout(r, DURATION));
          return { name };
        } finally {
          endTimes[name] = Date.now();
          active.splice(active.indexOf(name), 1);
        }
      },
    };

    const handler = createOperationHandler(executor, logger, { maxConcurrentOperations: MAX_CONCURRENT });

    const ops = ["op_a", "op_b", "op_c", "op_d"];
    const results = await Promise.all(ops.map((op) => handler(op, {})));

    for (const r of results) {
      expect(r.isError).not.toBe(true);
    }

    expect(Math.max(...activeSnapshots)).toBeLessThanOrEqual(MAX_CONCURRENT);
  }, 10_000);

  test("activeRequests en lifecycle nunca excede maxConcurrentOperations", async () => {
    const logger = new MemoryLogger();
    let resolveSlow: () => void;
    const slow = new Promise<void>((r) => { resolveSlow = r; });

    const executor = {
      execute: async (name: string) => {
        if (name === "slow") {
          await slow;
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      },
    };

    const handler = createOperationHandler(executor, logger, { maxConcurrentOperations: 2 });

    const p1 = handler("slow", {});
    const p2 = handler("fast_1", {});
    await new Promise((r) => setTimeout(r, 20));
    const p3 = handler("fast_2", {});

    const startEvents = logger.events.filter((e) => e.message === "mcp.request.start");
    const activeReqValues = startEvents.map((e) => (e.data as { activeRequests: number }).activeRequests);

    expect(Math.max(...activeReqValues)).toBeLessThanOrEqual(2);

    resolveSlow!();
    await Promise.all([p1, p2, p3]);
  }, 10_000);

  test("operacion encolada que agota su queueTimeoutMs es rechazada con error claro", async () => {
    const logger = new MemoryLogger();

    let releaseFirst: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });

    const executor = {
      execute: async (name: string) => {
        if (name === "first") {
          await firstDone;
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      },
    };

    const handler = createOperationHandler(executor, logger, {
      maxConcurrentOperations: 1,
      queueTimeoutMs: 10,
    });

    const p1 = handler("first", {});
    await new Promise((r) => setTimeout(r, 5));

    const p2 = handler("second", {});

    await new Promise((r) => setTimeout(r, 15));

    releaseFirst!();
    await p1;

    const result = await p2;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toMatch(/timeout|queued|try again/i);
  }, 10_000);

  test("lifecycle tracing sigue emitiendo eventos con concurrency activo", async () => {
    const logger = new MemoryLogger();
    const executor = {
      execute: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true }; },
    };

    const handler = createOperationHandler(executor, logger, { maxConcurrentOperations: 2 });

    await Promise.all([
      handler("op_1", {}),
      handler("op_2", {}),
      handler("op_3", {}),
    ]);

    expect(logger.events.some((e) => e.message === "mcp.request.start")).toBe(true);
    expect(logger.events.some((e) => e.message === "mcp.request.end")).toBe(true);

    const startEvents = logger.events.filter((e) => e.message === "mcp.request.start");
    for (const evt of startEvents) {
      expect((evt.data as { activeRequests: number }).activeRequests).toBeLessThanOrEqual(2);
    }
  });

  test("rechaza inmediatamente cuando la cola MCP global alcanza su limite", async () => {
    const logger = new MemoryLogger();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executor = {
      execute: async (name: string) => {
        if (name === "first") await blocked;
        return { ok: true };
      },
    };

    const handler = createOperationHandler(executor, logger, {
      maxConcurrentOperations: 1,
      maxQueuedOperations: 1,
      queueTimeoutMs: 5_000,
    });

    const first = handler("first", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = handler("second", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await handler("third", {});

    expect(third.isError).toBe(true);
    expect(third.content[0]!.text).toMatch(/MCP_BUSY|queue.*full|busy/i);
    expect(handler.getBackpressureSnapshot()).toMatchObject({
      active: 1,
      activeLimit: 1,
      queued: 1,
      queueLimit: 1,
      rejected: 1,
    });

    release();
    await Promise.all([first, second]);
    expect(handler.getBackpressureSnapshot()).toMatchObject({ active: 0, queued: 0, rejected: 1 });
  });

  test("round-robin evita que un requester monopolice la cola cuando sessionId esta disponible", async () => {
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const executor = {
      execute: async (name: string) => {
        starts.push(name);
        await new Promise<void>((resolve) => { releases.set(name, resolve); });
        return { ok: true };
      },
    };
    const handler = createOperationHandler(executor, undefined, {
      maxConcurrentOperations: 1,
      maxQueuedOperations: 8,
      queueTimeoutMs: 5_000,
    });

    const seed = handler("seed", {}, { requesterId: "seed" });
    await waitUntil(() => starts.includes("seed"));
    const a1 = handler("a1", {}, { requesterId: "A" });
    const a2 = handler("a2", {}, { requesterId: "A" });
    const b1 = handler("b1", {}, { requesterId: "B" });
    await waitUntil(() => handler.getBackpressureSnapshot().queued === 3);

    releases.get("seed")!();
    await seed;
    await waitUntil(() => starts.length === 2);
    expect(starts[1]).toBe("a1");

    releases.get("a1")!();
    await a1;
    await waitUntil(() => starts.length === 3);
    expect(starts[2]).toBe("b1");

    releases.get("b1")!();
    await b1;
    await waitUntil(() => starts.length === 4);
    expect(starts[3]).toBe("a2");
    releases.get("a2")!();
    await a2;
  });

});
