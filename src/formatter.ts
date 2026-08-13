import chalk from "chalk";
import boxen from "boxen";
import highlight from "cli-highlight";
import { execSync } from "node:child_process";
import { parseShellCommand } from "./command-cleaner";
import { cleanToolResultText } from "./result-cleaner";

export class LogFormatter {
  private isVerbose: boolean;
  private maxLines: number;

  constructor(options: { verbose?: boolean; maxLines?: number } = {}) {
    this.isVerbose = !!options.verbose;
    this.maxLines = options.maxLines !== undefined ? options.maxLines : 15;
  }

  public formatLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Filter node stack traces when not verbose
    if (!this.isVerbose && /^\s*at\s+/.test(line)) {
      return null;
    }

    // Verbose line handling
    if (trimmed.startsWith("[DEBUG]")) {
      if (!this.isVerbose && trimmed.includes("Verbose mode:")) return null;
      if (!this.isVerbose && trimmed.includes("Failed to set session")) {
        return `${chalk.yellow("⚠️")} ${chalk.dim("Session expired, starting fresh authentication...")}`;
      }
      return chalk.dim(trimmed);
    }

    // Startup & connection info
    if (trimmed.includes("☕ No sleep mode enabled") || trimmed.includes("☕ No sleep mode active")) {
      return `${chalk.blue("☕")} ${chalk.bold("No sleep mode active")}`;
    }
    if (trimmed.includes("🚀 Starting MCP Device...")) {
      return `${chalk.bold.cyan("🚀 Starting Desktop Commander MCP...")}`;
    }
    if (trimmed.includes("Connecting to Local Desktop Commander")) {
      return `${chalk.dim(" - ⏳ Connecting to local MCP service...")}`;
    }
    if (trimmed.includes("Connected to Local Desktop Commander MCP")) {
      return `${chalk.green(" - 🔌 Connected to local MCP")}`;
    }
    if (trimmed.includes("Connecting to Remote MCP")) {
      return `${chalk.dim(" - ⏳ Connecting to remote server (https://mcp.desktopcommander.app)...")}`;
    }
    if (trimmed.includes("Connected to Remote MCP")) {
      return `${chalk.green(" - 🔌 Connected to Remote MCP")}`;
    }
    if (trimmed.includes("Persisted session invalid")) {
      return `${chalk.yellow(" - ⚠️ Persisted session invalid, re-authenticating...")}`;
    }
    if (trimmed.includes("Channel subscribed") || trimmed.includes("Device marked as online")) {
      return null;
    }
    if (trimmed.includes("Waiting for authorization...")) {
      return `${chalk.cyan(" - ⏳ Waiting for browser authorization...")}`;
    }
    if (trimmed.includes("Authorization successful!")) {
      return `${chalk.green.bold(" - ✅ Authorization successful!")}`;
    }

    return line;
  }

  public formatAuthFlow(url: string, code: string, expiresIn: string): string {
    // Attempt auto-copy to macOS clipboard
    let copiedMsg = "";
    try {
      execSync("pbcopy", { input: code, timeout: 2000 });
      copiedMsg = `  ${chalk.green.bold("📋 Code copied to clipboard!")}`;
    } catch {}

    const card = `
${chalk.bold.cyan("🔐 ACTION REQUIRED: Authenticate Device")}

${chalk.bold("1. Open URL in your browser:")}
   ${chalk.underline.blue(url)}

${chalk.bold("2. Enter verification code:")}
   ${chalk.bgYellow.black.bold(`  ${code}  `)}${copiedMsg}

${chalk.dim(`⌛ Code expires in ${expiresIn}`)}
`.trim();

    return boxen(card, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderColor: "yellow",
      borderStyle: "round",
    });
  }

  public formatDeviceReady(user: string, deviceId: string, deviceName: string): string {
    const card = `
${chalk.bold.green("✨ DESKTOP COMMANDER READY")}

${chalk.bold("👤 User:")}        ${user}
${chalk.bold("💻 Device:")}      ${deviceName}
${chalk.bold("🆔 Device ID:")}   ${deviceId}
${chalk.bold("🔌 Status:")}      ${chalk.green("Online & Subscribed")}
`.trim();

    return boxen(card, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderColor: "green",
      borderStyle: "round",
    });
  }

  public formatToolCall(toolName: string, callId: string, argsJsonStr: string): string {
    let args: any = {};
    try {
      args = JSON.parse(argsJsonStr);
    } catch {}

    const shortId = callId ? callId.slice(0, 8) : "";
    const header = `${chalk.bgCyan.black.bold(` ⚡ TOOL CALL `)} ${chalk.bold.cyan(toolName)} ${chalk.dim(`[id: ${shortId}]`)}`;

    const details: string[] = [];

    if (toolName === "start_process" || toolName === "run_command" || toolName === "exec") {
      const shell = args.shell || "bash";
      const timeout = args.timeout_ms ? `${args.timeout_ms / 1000}s` : null;

      details.push(chalk.dim(`Shell: ${shell}${timeout ? ` | Timeout: ${timeout}` : ""}`));

      if (args.command) {
        const steps = parseShellCommand(args.command);
        details.push(chalk.bold("\nExecution Steps:"));
        steps.forEach((step, idx) => {
          if (step.type === "cd") {
            details.push(`  ${chalk.yellow(`${idx + 1}.`)} ${chalk.bold("cd")} ${makeClickablePath(step.path)}`);
          } else if (step.type === "write_file") {
            details.push(`  ${chalk.yellow(`${idx + 1}.`)} ${chalk.bold("Write File:")} ${makeClickablePath(step.filePath)}`);
            const lineCount = step.fileContent.split("\n").length;
            details.push(chalk.dim(`     (${lineCount} lines written)`));

            const previewLines = wrapLines(step.fileContent.split("\n").slice(0, 12).join("\n"));
            try {
              const lang = getLanguageFromFile(step.filePath);
              const highlighted = highlight(previewLines, { language: lang, ignoreIllegals: true });
              details.push(boxen(highlighted, { padding: 0.5, borderColor: "gray", borderStyle: "single" }));
            } catch {
              details.push(boxen(previewLines, { padding: 0.5, borderColor: "gray", borderStyle: "single" }));
            }
          } else if (step.type === "script_exec") {
            details.push(`  ${chalk.yellow(`${idx + 1}.`)} ${chalk.bold(`Exec ${step.language.toUpperCase()} Script`)} ${chalk.dim(`(${step.interpreter})`)}`);
            const wrappedCode = wrapLines(step.code.trim());
            try {
              const highlighted = highlight(wrappedCode, { language: step.language, ignoreIllegals: true });
              details.push(boxen(highlighted, { padding: 0.5, borderColor: "gray", borderStyle: "single" }));
            } catch {
              details.push(boxen(wrappedCode, { padding: 0.5, borderColor: "gray", borderStyle: "single" }));
            }
          } else {
            let cmdFormatted = step.cmd;
            try {
              cmdFormatted = highlight(step.cmd, { language: "bash", ignoreIllegals: true });
            } catch {}
            details.push(`  ${chalk.yellow(`${idx + 1}.`)} ${cmdFormatted}`);
          }
        });
      }
    } else if (toolName === "read_file") {
      const filePath = args.path || args.filePath || "";
      details.push(`${chalk.bold("Path:")} ${makeClickablePath(filePath)}`);
      if (args.offset !== undefined || args.length !== undefined) {
        details.push(chalk.dim(`Offset: ${args.offset ?? 0}, Length: ${args.length ?? "auto"}`));
      }
    } else if (toolName === "read_process_output") {
      details.push(`${chalk.bold("PID:")} ${args.pid} ${chalk.dim(`| Length: ${args.length ?? 3000}`)}`);
    } else {
      try {
        const prettyArgs = JSON.stringify(args, null, 2);
        if (prettyArgs !== "{}") {
          const highlighted = highlight(prettyArgs, { language: "json", ignoreIllegals: true });
          details.push(highlighted);
        }
      } catch {
        details.push(chalk.dim(JSON.stringify(args)));
      }
    }

    const content = `${header}\n\n${details.join("\n")}`;

    return boxen(content, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 0 },
      borderColor: "cyan",
      borderStyle: "round",
    });
  }

  public formatToolCompleted(toolName: string, rawResultText: string, durationMs?: number, forceFull?: boolean): string {
    const durationStr = durationMs !== undefined ? chalk.dim(` (${formatDuration(durationMs)})`) : "";
    const header = `${chalk.bgGreen.black.bold(` ✔ COMPLETED `)} ${chalk.bold.green(toolName)}${durationStr}`;

    const cleaned = cleanToolResultText(rawResultText, { maxLines: forceFull ? 0 : this.maxLines });
    const content = `${header}\n\n${cleaned.formattedText}`;

    return boxen(content, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 1 },
      borderColor: "green",
      borderStyle: "round",
    });
  }

  public formatToolFailed(toolName: string, errorMessage: string, durationMs?: number, forceFull?: boolean): string {
    const durationStr = durationMs !== undefined ? chalk.dim(` (${formatDuration(durationMs)})`) : "";
    const header = `${chalk.bgRed.white.bold(` ✖ FAILED `)} ${chalk.bold.red(toolName)}${durationStr}`;

    const cleaned = cleanToolResultText(errorMessage, { maxLines: forceFull ? 0 : this.maxLines });
    const content = `${header}\n\n${cleaned.formattedText}`;

    return boxen(content, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 1 },
      borderColor: "red",
      borderStyle: "round",
    });
  }

  public formatSessionSummary(stats: { total: number; success: number; failed: number; startTime: number }): string {
    const durationMs = Date.now() - stats.startTime;
    const summary = `
${chalk.bold.cyan("📊 SESSION SUMMARY")}

${chalk.bold("⏱️  Duration:")}     ${formatDuration(durationMs)}
${chalk.bold("🛠️  Total Calls:")}  ${stats.total}
${chalk.bold("✅ Successful:")}   ${chalk.green(stats.success)}
${chalk.bold("❌ Failed:")}       ${stats.failed > 0 ? chalk.red(stats.failed) : chalk.dim("0")}
`.trim();

    return boxen(summary, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderColor: "blue",
      borderStyle: "round",
    });
  }
}

function wrapLines(code: string, maxLen = 95): string {
  return code
    .split("\n")
    .map((line) => {
      if (line.length <= maxLen) return line;
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      return chunks.join("\n  ");
    })
    .join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  if (parseFloat(sec) < 60) return `${sec}s`;
  const min = Math.floor(parseFloat(sec) / 60);
  const remSec = Math.round(parseFloat(sec) % 60);
  return `${min}m ${remSec}s`;
}

function makeClickablePath(filePath: string): string {
  if (!filePath) return "";
  // OSC 8 hyperlink format for terminal
  const osc8 = `\u001b]8;;file://${filePath}\u001b\\${chalk.green(filePath)}\u001b]8;;\u001b\\`;
  return osc8;
}

function getLanguageFromFile(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html")) return "html";
  if (filePath.endsWith(".sh") || filePath.endsWith(".bash")) return "bash";
  if (filePath.endsWith(".py")) return "python";
  return "plaintext";
}
