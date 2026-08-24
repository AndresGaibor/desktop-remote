export const DEFAULT_API_KEY_REF = "env:CONTROL_PLANE_API_KEY";

export interface TunnelProfile {
  tunnelId: string;
  mcpCommand: string;
  apiKeyRef: typeof DEFAULT_API_KEY_REF;
}

type ProfileInput = Partial<{
  tunnel_id: unknown;
  tunnelId: unknown;
  mcp_command: unknown;
  mcpCommand: unknown;
  api_key_ref: unknown;
  apiKeyRef: unknown;
  api_key: unknown;
  apiKey: unknown;
  control_plane: {
    tunnel_id?: unknown;
    api_key?: unknown;
  };
  mcp: {
    commands?: Array<{ channel?: unknown; command?: unknown }>;
  };
}>;

export function createTunnelProfile(input: ProfileInput): TunnelProfile {
  rejectLiteralKey(input);
  const tunnelId = input.tunnel_id ?? input.tunnelId ?? input.control_plane?.tunnel_id;
  const mcpCommand = input.mcp_command ?? input.mcpCommand ?? input.mcp?.commands?.[0]?.command;
  const apiKeyRef = input.api_key_ref ?? input.apiKeyRef ?? input.control_plane?.api_key ?? DEFAULT_API_KEY_REF;

  if (typeof tunnelId !== "string" || !/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    throw new Error("tunnel_id must match tunnel_ followed by 32 lowercase hexadecimal characters");
  }
  if (typeof mcpCommand !== "string" || !mcpCommand.trim()) throw new Error("mcp_command is required");
  rejectSecretText(mcpCommand);
  if (apiKeyRef !== DEFAULT_API_KEY_REF) throw new Error("api_key_ref must reference CONTROL_PLANE_API_KEY");

  return { tunnelId, mcpCommand: mcpCommand.trim(), apiKeyRef: DEFAULT_API_KEY_REF };
}

export function parseTunnelProfile(source: string | ProfileInput): TunnelProfile {
  if (typeof source !== "string") return createTunnelProfile(source);
  const text = source.trim();
  if (!text) throw new Error("tunnel profile is empty");
  if (text.startsWith("{")) {
    try {
      return createTunnelProfile(JSON.parse(text) as ProfileInput);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("invalid tunnel profile JSON");
      throw error;
    }
  }
  const values: ProfileInput = {};
  let section = "";
  let inCommands = false;
  let command: { channel?: unknown; command?: unknown } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0 && trimmed.endsWith(":")) {
      section = trimmed.slice(0, -1).trim();
      inCommands = section === "mcp.commands";
      if (section === "mcp") inCommands = false;
      continue;
    }
    if (indentation === 0 && trimmed.startsWith("mcp:")) {
      section = "mcp";
      inCommands = false;
      continue;
    }
    if (section === "mcp" && trimmed === "commands:") {
      inCommands = true;
      continue;
    }
    if (inCommands && trimmed.startsWith("-")) {
      command = {};
      const inline = trimmed.slice(1).trim();
      if (inline) assignNestedValue(command, inline);
      (values.mcp ??= {}).commands = [command];
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 1) throw new Error("invalid tunnel profile YAML");
    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    if (section === "control_plane" && indentation > 0) {
      values.control_plane = { ...values.control_plane, [key]: value };
    } else if (inCommands && command) {
      assignNestedValue(command, trimmed);
    } else {
      (values as Record<string, unknown>)[key] = value;
    }
  }
  return createTunnelProfile(values);
}

export function serializeTunnelProfile(profile: TunnelProfile, format: "yaml" | "json"): string {
  const safe = createTunnelProfile({
    tunnel_id: profile.tunnelId,
    mcp_command: profile.mcpCommand,
    api_key_ref: profile.apiKeyRef,
  });
  const values = {
    config_version: 1,
    control_plane: { base_url: "https://api.openai.com", tunnel_id: safe.tunnelId, api_key: safe.apiKeyRef },
    health: { listen_addr: "127.0.0.1:0" },
    admin_ui: { open_browser: false },
    log: { level: "info", format: "json" },
    mcp: { commands: [{ channel: "main", command: safe.mcpCommand }] },
  };
  return format === "json" ? `${JSON.stringify(values, null, 2)}\n` : [
    "config_version: 1",
    "control_plane:",
    `  base_url: ${yamlValue(values.control_plane.base_url)}`,
    `  tunnel_id: ${yamlValue(values.control_plane.tunnel_id)}`,
    `  api_key: ${yamlValue(values.control_plane.api_key)}`,
    "health:",
    `  listen_addr: ${yamlValue(values.health.listen_addr)}`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: ${yamlValue(safe.mcpCommand)}`,
  ].join("\n") + "\n";
}

function rejectLiteralKey(input: ProfileInput): void {
  const apiKey = input.api_key ?? input.apiKey ?? input.control_plane?.api_key;
  if (apiKey !== undefined && apiKey !== DEFAULT_API_KEY_REF) throw new Error("literal API key/secret is forbidden");
  for (const value of Object.values(input)) if (typeof value === "string") rejectSecretText(value);
}

function assignNestedValue(target: Record<string, unknown>, entry: string): void {
  const separator = entry.indexOf(":");
  if (separator < 1) throw new Error("invalid tunnel profile YAML");
  target[entry.slice(0, separator).trim()] = unquote(entry.slice(separator + 1).trim());
}

function rejectSecretText(value: string): void {
  if (/sk-[A-Za-z0-9_-]{8,}|(?:api[-_ ]?key|token)\s*[:=]/i.test(value)) throw new Error("literal API key/secret is forbidden");
}

function unquote(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function yamlValue(value: string): string {
  return /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : JSON.stringify(value);
}
