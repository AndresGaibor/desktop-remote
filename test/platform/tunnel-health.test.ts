import { describe, expect, test } from "bun:test";
import { probeTunnelDiagnostics, probeTunnelHealth } from "../../src/platform/tunnel-health";

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("probeTunnelHealth", () => {
  test("reports ready when liveness and readiness are healthy", async () => {
    const result = await probeTunnelHealth("/tmp/tunnel-health.url", {
      readFile: async () => "http://127.0.0.1:4321\n",
      fetch: async (input) => {
        const url = String(input);
        return url.endsWith("/readyz") ? response(200, "ready") : response(200, "live");
      },
    });

    expect(result.state).toBe("ready");
    expect(result.baseUrl).toBe("http://127.0.0.1:4321");
    expect(result.healthz).toMatchObject({ ok: true, status: 200, body: "live" });
    expect(result.readyz).toMatchObject({ ok: true, status: 200, body: "ready" });
  });

  test("distinguishes alive but unready", async () => {
    const result = await probeTunnelHealth("/tmp/tunnel-health.url", {
      readFile: async () => "http://127.0.0.1:4321",
      fetch: async (input) => String(input).endsWith("/readyz")
        ? response(503, "not ready")
        : response(200, "live"),
    });

    expect(result.state).toBe("not_ready");
    expect(result.healthz.ok).toBe(true);
    expect(result.readyz).toMatchObject({ ok: false, status: 503 });
  });

  test("reports not configured when the dynamic URL file is missing", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    const result = await probeTunnelHealth("/tmp/tunnel-health.url", {
      readFile: async () => { throw error; },
      fetch: async () => response(200, "unused"),
    });

    expect(result.state).toBe("not_configured");
    expect(result.baseUrl).toBeNull();
  });

  test("reports unreachable when the local endpoint cannot be contacted", async () => {
    const result = await probeTunnelHealth("/tmp/tunnel-health.url", {
      readFile: async () => "http://127.0.0.1:4321",
      fetch: async () => { throw new Error("connection refused"); },
    });

    expect(result.state).toBe("unreachable");
    expect(result.healthz.ok).toBe(false);
    expect(result.readyz.ok).toBe(false);
  });

  test("rejects non-loopback health URLs", async () => {
    const result = await probeTunnelHealth("/tmp/tunnel-health.url", {
      readFile: async () => "https://example.com:443",
      fetch: async () => response(200, "must not be called"),
    });

    expect(result.state).toBe("invalid");
    expect(result.baseUrl).toBeNull();
  });
});

describe("probeTunnelDiagnostics", () => {
  test("consulta solo loopback y devuelve una selección acotada de estado y métricas", async () => {
    const requested: string[] = [];
    const result = await probeTunnelDiagnostics("/tmp/tunnel-health.url", {
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
      readFile: async () => "http://127.0.0.1:4321",
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/healthz")) return response(200, "live");
        if (url.endsWith("/readyz")) return response(200, "ready");
        if (url.endsWith("/api/status")) return response(200, JSON.stringify({
          pid: 123,
          mcp: { status: "connected", pid: 234 },
          channel: { status: "ready", pid: 235 },
          polling: { last_success_at: "2026-08-27T11:59:30.000Z" },
          queue: { depth: 2 },
          workers: { active: 2, capacity: 4 },
          token: "sk-live-secret-value",
        }));
        if (url.endsWith("/api/system")) return response(200, JSON.stringify({
          pid: 123,
          version: "0.0.13",
          authorization: "Bearer secret-value",
        }));
        return response(200, [
          "tunnel_poll_last_success_timestamp_seconds 1787831970",
          "tunnel_queue_depth 7",
          "tunnel_worker_active 3",
          "tunnel_worker_capacity 5",
        ].join("\n"));
      },
    });

    expect([...requested].sort()).toEqual([
      "http://127.0.0.1:4321/healthz",
      "http://127.0.0.1:4321/readyz",
      "http://127.0.0.1:4321/api/status",
      "http://127.0.0.1:4321/api/system",
      "http://127.0.0.1:4321/metrics",
    ].sort());
    expect(result.state).toBe("ready");
    expect(result.selected).toMatchObject({
      liveness: true,
      readiness: true,
      pid: 123,
      mcp: { status: "connected", pid: 234 },
      channel: { status: "ready", pid: 235 },
      queue: { depth: 7 },
      workers: { active: 3, capacity: 5, occupancy: 0.6 },
    });
    expect(result.selected.polling?.lastSuccessAt).toBe("2026-08-27T11:59:30.000Z");
    expect(result.selected.polling?.ageMs).toBe(30_000);
    expect(result.api.status.available).toBe(true);
    expect(result.metrics.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-value");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  test("mantiene el estado local cuando faltan las superficies opcionales", async () => {
    const result = await probeTunnelDiagnostics("/tmp/tunnel-health.url", {
      readFile: async () => "http://localhost:4321",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return response(200, "live");
        if (url.endsWith("/readyz")) return response(200, "ready");
        throw new Error("optional endpoint unavailable");
      },
    });

    expect(result.state).toBe("ready");
    expect(result.selected.liveness).toBe(true);
    expect(result.selected.readiness).toBe(true);
    expect(result.api.status.available).toBe(false);
    expect(result.api.system.available).toBe(false);
    expect(result.metrics.available).toBe(false);
  });

  test("interpreta dispatcher_worker_pool_occupancy como workers activos, no como porcentaje", async () => {
    const result = await probeTunnelDiagnostics("/tmp/tunnel-health.url", {
      readFile: async () => "http://127.0.0.1:4321",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return response(200, "live");
        if (url.endsWith("/readyz")) return response(200, "ready");
        if (url.endsWith("/metrics")) return response(200, [
          "commands_queue_capacity 20",
          "commands_queue_length 0",
          "dispatcher_worker_pool_capacity 10",
          "dispatcher_worker_pool_occupancy 1",
        ].join("\n"));
        throw new Error("optional endpoint unavailable");
      },
    });

    expect(result.selected.queue).toEqual({ depth: 0, capacity: 20 });
    expect(result.selected.workers).toEqual({ active: 1, capacity: 10, occupancy: 0.1 });
  });

});
