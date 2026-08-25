import { describe, expect, test } from "bun:test";
import { launchAgentTunnelPlist, systemdTunnelUnit } from "../../src/platform/tunnel-services";

describe("tunnel service definitions", () => {
  const command = "/opt/openai/tunnel-client";
  const profilePath = "/Users/alice/Library/Application Support/desktop-remote/tunnel.json";

  test("generates a LaunchAgent with profile path, loopback health, and restart policy", () => {
    const plist = launchAgentTunnelPlist(command, profilePath);

    expect(plist).toContain(command);
    expect(plist).toContain(profilePath);
    expect(plist).toContain("127.0.0.1");
    expect(plist).toContain("--health.url-file");
    expect(plist).toContain("tunnel-health.url");
    expect(plist).toContain("KeepAlive");
    expect(plist).not.toContain("CONTROL_PLANE_API_KEY=");
    expect(plist).not.toContain("sk-live");
  });

  test("generates a systemd user unit without literal secrets", () => {
    const unit = systemdTunnelUnit(command, profilePath);

    expect(unit).toContain(`ExecStart=${command}`);
    expect(unit).toContain(profilePath);
    expect(unit).toContain("127.0.0.1");
    expect(unit).toContain("--health.url-file");
    expect(unit).toContain("tunnel-health.url");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("CONTROL_PLANE_API_KEY=");
    expect(unit).not.toContain("sk-live");
  });
});
