import { describe, expect, test } from "bun:test";
import { probeTunnelHealth } from "../../src/platform/tunnel-health";

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
