import type { RuntimeEvent, StreamSource } from "./events";

type ParserState = "normal" | "auth" | "device" | "tool-result";

interface ParserOptions {
  now?: () => number;
}

export class UpstreamParser {
  private readonly now: () => number;
  private state: ParserState = "normal";
  private authUrl = "";
  private authCode = "";
  private authExpires = "";
  private deviceUser = "";
  private deviceId = "";
  private deviceName = "";
  private pendingResultTool = "";
  private pendingResultLines: string[] = [];
  private readonly activeByTool = new Map<string, string[]>();
  private readonly startedAtByCall = new Map<string, number>();

  constructor(options: ParserOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  pushLine(rawLine: string, source: StreamSource = "stdout"): RuntimeEvent[] {
    const line = rawLine.trimEnd();

    if (this.state === "auth") {
      const url = line.match(/https:\/\/[^\s]+/)?.[0];
      const code = line.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
      if (url) this.authUrl = url;
      if (code) this.authCode = code;
      if (line.includes("Code expires in")) {
        this.authExpires = line.replace(/.*Code expires in\s*/, "").trim();
      }
      if (this.authUrl && this.authCode && this.authExpires) {
        const event: RuntimeEvent = {
          type: "auth.required",
          url: this.authUrl,
          code: this.authCode,
          expiresIn: this.authExpires,
          at: this.now(),
        };
        this.resetAuth();
        this.state = "normal";
        return [event];
      }
      return [];
    }

    if (this.state === "device") {
      this.collectDeviceLine(line);
      if (this.deviceUser && this.deviceId && this.deviceName) {
        const event: RuntimeEvent = {
          type: "device.ready",
          user: this.deviceUser,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          at: this.now(),
        };
        this.resetDevice();
        this.state = "normal";
        return [event];
      }
      return [];
    }
    if (this.state === "tool-result") {
      this.pendingResultLines.push(line);
      const combined = this.pendingResultLines.join("\n").trim();
      if (!canParseToolResult(combined)) return [];

      const toolName = this.pendingResultTool;
      this.pendingResultTool = "";
      this.pendingResultLines = [];
      this.state = "normal";
      return [this.completeTool(toolName, extractToolResultText(combined))];
    }

    if (line.includes("Please complete authentication:")) {
      this.state = "auth";
      return [];
    }
    if (line.includes("✅ Device ready:")) {
      this.state = "device";
      return [];
    }

    const started = line.match(
      /^🔧\s*Received tool call\s+([^:]+):\s*([\w-]+)\s+([\s\S]*?)\s+metadata:\s+([\s\S]+)$/,
    );
    if (started) {
      const callId = started[1]?.trim();
      const toolName = started[2]?.trim();
      if (!callId || !toolName) return this.runtimeLog(line, source);
      const startedAt = this.now();
      this.startedAtByCall.set(callId, startedAt);
      const queue = this.activeByTool.get(toolName) ?? [];
      queue.push(callId);
      this.activeByTool.set(toolName, queue);
      return [{
        type: "tool.started",
        callId,
        toolName,
        args: parseJsonOrText(started[3] ?? "{}"),
        metadata: parseJsonOrText(started[4] ?? "{}"),
        startedAt,
      }];
    }
    const completed = line.match(/^✅\s*Tool call\s+([\w-]+)\s+completed:\s*(.*)$/);
    if (completed) {
      const toolName = completed[1];
      if (!toolName) return this.runtimeLog(line, source);
      const remainder = completed[2]?.trim() ?? "";
      if (remainder && canParseToolResult(remainder)) {
        return [this.completeTool(toolName, extractToolResultText(remainder))];
      }
      this.pendingResultTool = toolName;
      this.pendingResultLines = remainder ? [remainder] : [];
      this.state = "tool-result";
      return [];
    }

    const failed = line.match(/^❌\s*Tool call\s+([\w-]+)\s+failed:\s*(.*)$/);
    if (failed) {
      const toolName = failed[1];
      if (!toolName) return this.runtimeLog(line, source);
      return [this.failTool(toolName, failed[2]?.trim() ?? "Unknown error")];
    }

    const execFailed = line.match(/^Error executing tool\s+([\w-]+):\s*(.*)$/);
    if (execFailed) {
      const toolName = execFailed[1];
      if (!toolName) return this.runtimeLog(line, source);
      return [this.failTool(toolName, execFailed[2]?.trim() ?? "Unknown error")];
    }

    return this.runtimeLog(line, source);
  }

  flush(): RuntimeEvent[] {
    if (this.state !== "tool-result" || !this.pendingResultTool) return [];
    const toolName = this.pendingResultTool;
    const text = this.pendingResultLines.join("\n").trim();
    this.pendingResultTool = "";
    this.pendingResultLines = [];
    this.state = "normal";
    return [this.completeTool(toolName, extractToolResultText(text))];
  }

  private completeTool(toolName: string, resultText: string): RuntimeEvent {
    const completedAt = this.now();
    const callId = this.takeCallId(toolName, completedAt);
    const startedAt = this.startedAtByCall.get(callId);
    this.startedAtByCall.delete(callId);
    return {
      type: "tool.completed",
      callId,
      toolName,
      resultText,
      durationMs: startedAt === undefined ? undefined : completedAt - startedAt,
      completedAt,
    };
  }

  private failTool(toolName: string, error: string): RuntimeEvent {
    const completedAt = this.now();
    const callId = this.takeCallId(toolName, completedAt);
    const startedAt = this.startedAtByCall.get(callId);
    this.startedAtByCall.delete(callId);
    return {
      type: "tool.failed",
      callId,
      toolName,
      error,
      durationMs: startedAt === undefined ? undefined : completedAt - startedAt,
      completedAt,
    };
  }

  private takeCallId(toolName: string, completedAt: number): string {
    const queue = this.activeByTool.get(toolName);
    const callId = queue?.shift();
    if (queue && queue.length === 0) this.activeByTool.delete(toolName);
    return callId ?? `unknown-${toolName}-${completedAt}`;
  }

  private collectDeviceLine(line: string) {
    if (line.includes("- User:")) {
      this.deviceUser = line.replace(/.*- User:\s*/, "").trim();
    } else if (line.includes("- Device ID:")) {
      this.deviceId = line.replace(/.*- Device ID:\s*/, "").trim();
    } else if (line.includes("- Device Name:")) {
      this.deviceName = line.replace(/.*- Device Name:\s*/, "").trim();
    }
  }
  private resetAuth() {
    this.authUrl = "";
    this.authCode = "";
    this.authExpires = "";
  }

  private resetDevice() {
    this.deviceUser = "";
    this.deviceId = "";
    this.deviceName = "";
  }

  private runtimeLog(line: string, source: StreamSource): RuntimeEvent[] {
    if (!line.trim()) return [];
    return [{ type: "runtime.log", source, message: line, at: this.now() }];
  }
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canParseToolResult(value: string): boolean {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function extractToolResultText(value: string): string {
  if (!value) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return value;

  return parsed.content
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
