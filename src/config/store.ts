import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomicJson } from "../platform/atomic-file";
import { summarizeToolCall } from "../telemetry/tool-call-summary";
import { redactText } from "../logging/redactor";

export interface DesktopRemoteConfig {
  blockedCommands: string[];
  defaultShell: string;
  allowedDirectories: string[];
  fileReadLineLimit: number;
  fileWriteLineLimit: number;
  telemetryEnabled: boolean;
}

export interface ToolCallRecord {
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  traceId?: string;
}

export interface RecentToolCallFilter {
  maxResults?: number;
  toolName?: string;
  since?: string;
}

const DEFAULT_CONFIG: DesktopRemoteConfig = {
  blockedCommands: [],
  defaultShell: "/bin/sh",
  allowedDirectories: [],
  fileReadLineLimit: 1000,
  fileWriteLineLimit: 1000,
  telemetryEnabled: false,
};
const MAX_TOOL_CALLS = 200;

export class ConfigStore {
  private readonly path: string;
  private config: DesktopRemoteConfig = cloneConfig(DEFAULT_CONFIG);
  private calls: ToolCallRecord[] = [];
  private loaded = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async getConfig(): Promise<DesktopRemoteConfig> {
    await this.ensureLoaded();
    return cloneConfig(this.config);
  }

  async setConfigValue(key: string, value: unknown): Promise<DesktopRemoteConfig> {
    await this.ensureLoaded();
    const nextValue = validateConfigValue(key, value);
    this.config = { ...this.config, [key]: nextValue } as DesktopRemoteConfig;
    await this.persist();
    return cloneConfig(this.config);
  }

  async recordToolCall(call: ToolCallRecord): Promise<void> {
    await this.ensureLoaded();
    this.calls = [...this.calls, sanitizeToolCall(call)].slice(-MAX_TOOL_CALLS);
    await this.persist();
  }

  async getUsageStats(): Promise<unknown> {
    await this.ensureLoaded();
    const byTool: Record<string, number> = {};
    for (const call of this.calls) byTool[call.toolName] = (byTool[call.toolName] ?? 0) + 1;
    return {
      totalCalls: this.calls.length,
      successfulCalls: this.calls.filter((call) => call.error === undefined).length,
      failedCalls: this.calls.filter((call) => call.error !== undefined).length,
      byTool,
    };
  }

  async getRecentToolCalls(filter: RecentToolCallFilter = {}): Promise<ToolCallRecord[]> {
    await this.ensureLoaded();
    const maxResults = filter.maxResults ?? 50;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
      throw new Error("maxResults must be an integer between 1 and 1000");
    }
    const since = filter.since ? Date.parse(filter.since) : undefined;
    if (since !== undefined && !Number.isFinite(since)) throw new Error("since must be a valid date");
    return this.calls
      .filter((call) => !filter.toolName || call.toolName === filter.toolName)
      .filter((call) => since === undefined || Date.parse(call.startedAt) >= since)
      .slice(-maxResults)
      .reverse()
      .map((call) => sanitizeToolCall(call));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isRecord(parsed)) return;
      if (isConfig(parsed.config)) this.config = { ...cloneConfig(DEFAULT_CONFIG), ...parsed.config };
      if (Array.isArray(parsed.calls)) this.calls = parsed.calls.filter(isToolCall).slice(-MAX_TOOL_CALLS).map((call) => sanitizeToolCall(call));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.config = cloneConfig(DEFAULT_CONFIG);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = { config: cloneConfig(this.config), calls: this.calls.map((call) => sanitizeToolCall(call)) };
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeAtomicJson(this.path, snapshot, 0o600);
      await chmod(this.path, 0o600);
    });
    await this.pendingWrite;
  }
}

export function defaultConfig(): DesktopRemoteConfig {
  return cloneConfig(DEFAULT_CONFIG);
}

function validateConfigValue(key: string, value: unknown): DesktopRemoteConfig[keyof DesktopRemoteConfig] {
  if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown config key: ${key}`);
  if (key === "blockedCommands" || key === "allowedDirectories") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${key} must be an array of non-empty strings`);
    }
    return [...value] as DesktopRemoteConfig[typeof key];
  }
  if (key === "defaultShell") {
    if (typeof value !== "string" || !value.trim()) throw new Error("defaultShell must be a non-empty string");
    return value;
  }
  if (key === "telemetryEnabled") {
    if (typeof value !== "boolean") throw new Error("telemetryEnabled must be a boolean");
    return value;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new Error(`${key} must be an integer between 1 and 1000000`);
  }
  return value as number;
}

function isConfig(value: unknown): value is Partial<DesktopRemoteConfig> {
  return isRecord(value) && Object.keys(value).every((key) => key in DEFAULT_CONFIG && validateStoredValue(key, value[key]));
}

function validateStoredValue(key: string, value: unknown): boolean {
  try { validateConfigValue(key, value); return true; } catch { return false; }
}

function isToolCall(value: unknown): value is ToolCallRecord {
  return isRecord(value) && typeof value.toolName === "string" && typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" && typeof value.durationMs === "number";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolCall(call: ToolCallRecord): ToolCallRecord {
  const summary = summarizeToolCall(call.toolName, call.arguments, call.result, call.error);
  return {
    ...call,
    arguments: summary.arguments,
    ...(summary.result === undefined ? { result: undefined } : { result: summary.result }),
    ...(summary.error === undefined ? { error: undefined } : { error: redactText(summary.error) }),
  };
}

function cloneConfig(config: DesktopRemoteConfig): DesktopRemoteConfig {
  return { ...config, blockedCommands: [...config.blockedCommands], allowedDirectories: [...config.allowedDirectories] };
}
