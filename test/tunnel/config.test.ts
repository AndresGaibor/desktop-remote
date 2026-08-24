import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTunnelProfile,
  parseTunnelProfile,
  serializeTunnelProfile,
} from "../../src/tunnel/config";

describe("tunnel profile", () => {
  test("creates and serializes a safe JSON profile", () => {
    const profile = createTunnelProfile({ tunnel_id: "tunnel_0123456789abcdef0123456789abcdef", mcp_command: "openai mcp" });

    expect(profile).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      mcpCommand: "openai mcp",
      apiKeyRef: "env:CONTROL_PLANE_API_KEY",
    });
    expect(JSON.parse(serializeTunnelProfile(profile, "json"))).toEqual({
      config_version: 1,
      control_plane: {
        base_url: "https://api.openai.com",
        tunnel_id: "tunnel_0123456789abcdef0123456789abcdef",
        api_key: "env:CONTROL_PLANE_API_KEY",
      },
      health: { listen_addr: "127.0.0.1:0" },
      admin_ui: { open_browser: false },
      log: { level: "info", format: "json" },
      mcp: { commands: [{ channel: "main", command: "openai mcp" }] },
    });
  });

  test("parses the nested tunnel-client YAML sample", () => {
    expect(parseTunnelProfile(`config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: "127.0.0.1:0"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  commands:
    - channel: main
      command: "openai mcp"
`)).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      mcpCommand: "openai mcp",
      apiKeyRef: "env:CONTROL_PLANE_API_KEY",
    });
  });

  test("serializes YAML accepted syntactically by tunnel-client doctor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-config-"));
    const path = join(directory, "profile.yaml");
    const profile = createTunnelProfile({ tunnel_id: "tunnel_0123456789abcdef0123456789abcdef", mcp_command: "bun --version" });
    await writeFile(path, serializeTunnelProfile(profile, "yaml"));

    const result = Bun.spawn(["tunnel-client", "doctor", "--config", path], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONTROL_PLANE_API_KEY: "test-only-key" },
    });
    expect(await result.exited).toBe(0);
  });

  test("parses YAML and keeps the API key as an environment reference", () => {
    expect(parseTunnelProfile("tunnel_id: tunnel_0123456789abcdef0123456789abcdef\nmcp_command: openai mcp\n")).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      mcpCommand: "openai mcp",
      apiKeyRef: "env:CONTROL_PLANE_API_KEY",
    });
  });

  test("rejects invalid tunnel IDs and literal API keys", () => {
    expect(() => createTunnelProfile({ tunnel_id: "bad id", mcp_command: "openai mcp" })).toThrow(
      "tunnel_id",
    );
    expect(() => parseTunnelProfile({ tunnel_id: "tunnel_0123456789abcdef0123456789abcdef", api_key: "sk-live-secret" })).toThrow(
      /literal|secret|API key/i,
    );
  });
});
