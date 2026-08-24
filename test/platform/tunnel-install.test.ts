import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDesktopRemotePaths } from "../../src/platform/paths";
import { doctorTunnel, initializeTunnel } from "../../src/platform/tunnel-install";

const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";

describe("tunnel installation", () => {
  test("saves a validated profile and generates only local service files", async () => {
    const home = await mkdtemp(join(tmpdir(), "desktop-remote-tunnel-"));
    const paths = getDesktopRemotePaths(home, {}, "darwin");
    await mkdir(paths.appSupportDir, { recursive: true });
    const result = await initializeTunnel(paths, { tunnelId, profile: JSON.stringify({ tunnel_id: tunnelId, mcp_command: "desktop-remote mcp" }), tunnelCommand: "/opt/tunnel-client" });
    expect(await readFile(paths.tunnelProfilePath, "utf8")).toContain(tunnelId);
    expect(await readFile(paths.tunnelLaunchAgentPath!, "utf8")).toContain("/opt/tunnel-client");
    expect(result.servicePath).toBe(paths.tunnelLaunchAgentPath!);
  });

  test("doctor validates a local profile without network access", async () => {
    const home = await mkdtemp(join(tmpdir(), "desktop-remote-tunnel-"));
    const paths = getDesktopRemotePaths(home, {}, "linux");
    await mkdir(paths.appSupportDir, { recursive: true });
    await initializeTunnel(paths, { tunnelId, profile: JSON.stringify({ tunnel_id: tunnelId, mcp_command: "desktop-remote mcp" }), tunnelCommand: "/opt/tunnel-client" });
    await expect(doctorTunnel(paths)).resolves.toEqual({ valid: true, tunnelId });
  });

  test("rejects literal API keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "desktop-remote-tunnel-"));
    const paths = getDesktopRemotePaths(home, {}, "linux");
    await mkdir(paths.appSupportDir, { recursive: true });
    await expect(initializeTunnel(paths, { tunnelId, profile: JSON.stringify({ tunnel_id: tunnelId, mcp_command: "desktop-remote mcp", api_key: "sk-live-secret-value" }), tunnelCommand: "/opt/tunnel-client" })).rejects.toThrow(/literal API key/i);
  });
});
