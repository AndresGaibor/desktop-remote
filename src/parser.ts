import { LogFormatter } from "./formatter";
import { cleanToolResultText } from "./result-cleaner";

export interface CompactedBlockInfo {
  toolName: string;
  rawText: string;
  durationMs?: number;
}

export interface ParseOutput {
  formattedText: string;
  compactedInfo?: CompactedBlockInfo;
}

export class LogParser {
  private formatter: LogFormatter;
  private state: "NORMAL" | "AWAITING_AUTH" | "AWAITING_DEVICE" | "AWAITING_TOOL_RESULT" = "NORMAL";

  // Auth accumulation state
  private authUrl = "";
  private authCode = "";
  private authExpires = "";

  // Device accumulation state
  private deviceUser = "";
  private deviceId = "";
  private deviceName = "";

  // Tool completion state
  private pendingCompletedToolName = "";
  private pendingResultLines: string[] = [];

  // Duration & Session Stats
  private toolStartTimes: Map<string, number> = new Map();
  private stats = {
    total: 0,
    success: 0,
    failed: 0,
    startTime: Date.now(),
  };

  constructor(formatter: LogFormatter) {
    this.formatter = formatter;
  }

  public parseLine(rawLine: string): ParseOutput | null {
    const line = rawLine.trimEnd();

    // Check state machine
    if (this.state === "AWAITING_AUTH") {
      if (line.includes("https://")) {
        const urlMatch = line.match(/(https:\/\/[^\s]+)/);
        if (urlMatch?.[1]) this.authUrl = urlMatch[1];
      }
      const codeMatch = line.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (codeMatch?.[1]) {
        this.authCode = codeMatch[1];
      }
      if (line.includes("Code expires in")) {
        this.authExpires = line.replace(/.*Code expires in\s*/, "").trim();
      }
      if (line.includes("Waiting for authorization") || (this.authUrl && this.authCode && this.authExpires)) {
        this.state = "NORMAL";
        const authCard = this.formatter.formatAuthFlow(this.authUrl, this.authCode, this.authExpires || "15 minutes");
        this.authUrl = "";
        this.authCode = "";
        this.authExpires = "";
        return { formattedText: authCard };
      }
      return null;
    }

    if (this.state === "AWAITING_DEVICE") {
      if (line.includes("- User:")) {
        this.deviceUser = line.replace(/.*- User:\s*/, "").trim();
      } else if (line.includes("- Device ID:")) {
        this.deviceId = line.replace(/.*- Device ID:\s*/, "").trim();
      } else if (line.includes("- Device Name:")) {
        this.deviceName = line.replace(/.*- Device Name:\s*/, "").trim();
      }

      if (this.deviceUser && this.deviceId && this.deviceName) {
        this.state = "NORMAL";
        const card = this.formatter.formatDeviceReady(this.deviceUser, this.deviceId, this.deviceName);
        this.deviceUser = "";
        this.deviceId = "";
        this.deviceName = "";
        return { formattedText: card };
      }

      if (line.startsWith("🔧") || line.startsWith("✅")) {
        this.state = "NORMAL";
      } else {
        return null;
      }
    }

    if (this.state === "AWAITING_TOOL_RESULT") {
      const isNewSection = line.startsWith("🔧") || line.startsWith("✅") || line.startsWith("❌") || line.startsWith("📋") || line.startsWith("Error executing");

      if (!isNewSection) {
        this.pendingResultLines.push(line);
        const combined = this.pendingResultLines.join("\n").trim();
        if (canParseToolResult(combined)) {
          const toolName = this.pendingCompletedToolName;
          this.state = "NORMAL";
          this.pendingCompletedToolName = "";
          this.pendingResultLines = [];

          const durationMs = this.getDurationAndClear(toolName);
          this.stats.total++;
          this.stats.success++;

          const rawResultText = extractTextFromToolResult(combined);
          const formattedText = this.formatter.formatToolCompleted(toolName, rawResultText, durationMs);
          const checkCompact = cleanToolResultText(rawResultText);

          return {
            formattedText,
            compactedInfo: checkCompact.isHidden ? { toolName, rawText: rawResultText, durationMs } : undefined,
          };
        }
        return null;
      } else {
        const toolName = this.pendingCompletedToolName;
        const combined = this.pendingResultLines.join("\n").trim();
        this.state = "NORMAL";
        this.pendingCompletedToolName = "";
        this.pendingResultLines = [];

        const durationMs = this.getDurationAndClear(toolName);
        this.stats.total++;
        this.stats.success++;

        const rawResultText = extractTextFromToolResult(combined);
        const completedCard = this.formatter.formatToolCompleted(toolName, rawResultText, durationMs);
        const checkCompact = cleanToolResultText(rawResultText);

        const nextOutput = this.parseLine(rawLine);
        const mergedText = completedCard + (nextOutput ? "\n" + nextOutput.formattedText : "");

        return {
          formattedText: mergedText,
          compactedInfo: checkCompact.isHidden ? { toolName, rawText: rawResultText, durationMs } : undefined,
        };
      }
    }

    // --- NORMAL LINE PARSING ---

    if (line.includes("Please complete authentication:")) {
      this.state = "AWAITING_AUTH";
      return null;
    }

    if (line.includes("✅ Device ready:")) {
      this.state = "AWAITING_DEVICE";
      return null;
    }

    // Tool call trigger
    const toolCallMatch = line.match(/^🔧\s*Received tool call\s+([a-f0-9-]+):\s*(\w+)\s*(\{[\s\S]*\})/);
    if (toolCallMatch) {
      const callId = toolCallMatch[1];
      const toolName = toolCallMatch[2];
      const argsJsonStr = toolCallMatch[3];
      if (!callId || !toolName || argsJsonStr === undefined) return null;
      this.toolStartTimes.set(toolName, Date.now());
      this.toolStartTimes.set(callId, Date.now());
      return { formattedText: this.formatter.formatToolCall(toolName, callId, argsJsonStr) };
    }

    // Tool completion trigger
    const completedMatch = line.match(/^✅\s*Tool call\s+(\w+)\s+completed:\s*(.*)$/);
    if (completedMatch) {
      const toolName = completedMatch[1];
      const remainder = completedMatch[2] ?? "";
      if (!toolName) return null;
      this.pendingCompletedToolName = toolName;
      this.pendingResultLines = [];

      if (remainder && remainder.trim()) {
        this.pendingResultLines.push(remainder.trim());
        const combined = remainder.trim();
        if (canParseToolResult(combined)) {
          this.state = "NORMAL";
          this.pendingCompletedToolName = "";
          this.pendingResultLines = [];

          const durationMs = this.getDurationAndClear(toolName);
          this.stats.total++;
          this.stats.success++;

          const rawResultText = extractTextFromToolResult(combined);
          const formattedText = this.formatter.formatToolCompleted(toolName, rawResultText, durationMs);
          const checkCompact = cleanToolResultText(rawResultText);

          return {
            formattedText,
            compactedInfo: checkCompact.isHidden ? { toolName, rawText: rawResultText, durationMs } : undefined,
          };
        }
      }

      this.state = "AWAITING_TOOL_RESULT";
      return null;
    }

    // Tool fail trigger
    const failMatch = line.match(/^❌\s*Tool call\s+(\w+)\s+failed:\s*(.*)$/);
    if (failMatch) {
      const toolName = failMatch[1];
      const errorMsg = failMatch[2] ?? "";
      if (!toolName) return null;
      const durationMs = this.getDurationAndClear(toolName);
      this.stats.total++;
      this.stats.failed++;

      const formattedText = this.formatter.formatToolFailed(toolName, errorMsg, durationMs);
      const checkCompact = cleanToolResultText(errorMsg);

      return {
        formattedText,
        compactedInfo: checkCompact.isHidden ? { toolName, rawText: errorMsg, durationMs } : undefined,
      };
    }

    // Exec error trigger
    const execErrMatch = line.match(/^Error executing tool\s+(\w+):\s*(.*)$/);
    if (execErrMatch) {
      const toolName = execErrMatch[1];
      const errorMsg = execErrMatch[2] ?? "";
      if (!toolName) return null;
      const durationMs = this.getDurationAndClear(toolName);
      this.stats.total++;
      this.stats.failed++;

      const formattedText = this.formatter.formatToolFailed(toolName, errorMsg, durationMs);
      const checkCompact = cleanToolResultText(errorMsg);

      return {
        formattedText,
        compactedInfo: checkCompact.isHidden ? { toolName, rawText: errorMsg, durationMs } : undefined,
      };
    }

    const simpleLine = this.formatter.formatLine(line);
    return simpleLine ? { formattedText: simpleLine } : null;
  }

  public flush(): ParseOutput | null {
    if (this.state === "AWAITING_TOOL_RESULT" && this.pendingCompletedToolName) {
      const toolName = this.pendingCompletedToolName;
      const combined = this.pendingResultLines.join("\n").trim();
      this.state = "NORMAL";
      this.pendingCompletedToolName = "";
      this.pendingResultLines = [];

      const durationMs = this.getDurationAndClear(toolName);
      this.stats.total++;
      this.stats.success++;

      const rawResultText = extractTextFromToolResult(combined);
      const formattedText = this.formatter.formatToolCompleted(toolName, rawResultText, durationMs);
      const checkCompact = cleanToolResultText(rawResultText);

      return {
        formattedText,
        compactedInfo: checkCompact.isHidden ? { toolName, rawText: rawResultText, durationMs } : undefined,
      };
    }
    return null;
  }

  public formatSummary(): string | null {
    if (this.stats.total === 0) return null;
    return this.formatter.formatSessionSummary(this.stats);
  }

  private getDurationAndClear(toolName: string): number | undefined {
    const startTime = this.toolStartTimes.get(toolName);
    if (startTime) {
      this.toolStartTimes.delete(toolName);
      return Date.now() - startTime;
    }
    return undefined;
  }
}

function extractTextFromToolResult(combined: string): string {
  if (!combined) return "";
  const json = tryParseJson(combined.trim());
  if (json && Array.isArray(json.content)) {
    return json.content
      .map((item: any) => (item.type === "text" ? item.text : JSON.stringify(item)))
      .join("\n");
  }
  return combined;
}

function canParseToolResult(combined: string): boolean {
  if (!combined) return false;
  const parsed = tryParseJson(combined.trim());
  return Boolean(parsed && (parsed.content !== undefined || typeof parsed === "object"));
}

function tryParseJson(str: string): any | null {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    try {
      const sanitized = str.replace(/[\u0000-\u001F]+/g, (m) => m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
      return JSON.parse(sanitized);
    } catch {
      try {
        const unescaped = str.replace(/\\n/g, "\n").replace(/\\"/g, '"');
        return JSON.parse(unescaped);
      } catch {
        return null;
      }
    }
  }
}
