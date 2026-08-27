import { dirname, join } from "node:path";
const HEALTH_ADDR = "127.0.0.1";
const TUNNEL_LABEL = "com.desktop-remote.tunnel";

export function launchAgentTunnelPlist(command: string, profilePath: string): string {
  validateInputs(command, profilePath);
  const args = [command, "run", "--profile-file", profilePath, "--health.listen-addr", `${HEALTH_ADDR}:0`, "--health.url-file", healthUrlFile(profilePath)];
  const logsDir = join(dirname(profilePath), "logs");
  const stdoutPath = join(logsDir, "tunnel.stdout.log");
  const stderrPath = join(logsDir, "tunnel.stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(TUNNEL_LABEL)}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n</dict></plist>\n`;
}

export function systemdTunnelUnit(command: string, profilePath: string): string {
  validateInputs(command, profilePath);
  const execStart = [command, "run", "--profile-file", profilePath, "--health.listen-addr", `${HEALTH_ADDR}:0`, "--health.url-file", healthUrlFile(profilePath)].map(systemdEscape).join(" ");
  return `[Unit]\nDescription=OpenAI tunnel-client\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${execStart}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}

export function tunnelHealthUrlFile(profilePath: string): string {
  return healthUrlFile(profilePath);
}

function healthUrlFile(profilePath: string): string {
  return join(dirname(profilePath), "tunnel-health.url");
}

function validateInputs(command: string, profilePath: string): void {
  if (!command.trim() || !profilePath.trim()) throw new Error("tunnel command and profile path are required");
  if (/(?:api[-_ ]?key|token)\s*[:=]|sk-[A-Za-z0-9_-]{8,}/i.test(command)) throw new Error("secrets are forbidden in tunnel command");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdEscape(value: string): string {
  const escaped = value.replaceAll("'", "\\'").replaceAll("%", "%%");
  return /[\s'"\\]/.test(value) ? `'${escaped}'` : escaped;
}
