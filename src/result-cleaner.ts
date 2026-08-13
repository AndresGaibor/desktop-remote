import chalk from "chalk";
import highlight from "cli-highlight";
import { formatErrorHintAndSuggestions } from "./suggestion-engine";


export interface ToolResultText {
  rawText: string;
  formattedText: string;
  type: "bun-test" | "git-status" | "file-read" | "code-grep" | "process-start" | "web-snapshot" | "json" | "error" | "generic";
  totalLines: number;
  isHidden: boolean;
}

export interface CleanerOptions {
  maxLines?: number; // 0 means no limit (full)
}

export function cleanToolResultText(text: string, options: CleanerOptions = {}): ToolResultText {
  const maxLines = options.maxLines !== undefined ? options.maxLines : 15;

  if (!text) {
    return { rawText: "", formattedText: chalk.dim("(empty response)"), type: "generic", totalLines: 0, isHidden: false };
  }

  // Separate noise lines (like .profile warnings) from actual output content
  const { noise, cleanText } = stripNoiseHeaderLines(text);

  // Check process start
  if (cleanText.includes("Process started with PID") || text.includes("Process started with PID")) {
    const lines = text.split("\n");
    const pidLine = lines[0];
    const rest = lines.slice(1).join("\n").replace(/^Initial output:\n?/, "").trim();

    let outputFormatted = "";
    if (rest) {
      const subResult = cleanToolResultText(rest, options);
      outputFormatted = subResult.formattedText;
    }

    const pidMatch = pidLine.match(/PID (\d+)/);
    const pidStr = pidMatch ? pidMatch[1] : "";

    const header = `${chalk.bold.cyan("🚀 Process Launched")} ${pidStr ? chalk.dim(`(PID: ${pidStr})`) : ""}`;
    const fullText = outputFormatted ? `${header}\n\n${outputFormatted}` : header;
    return {
      rawText: text,
      formattedText: fullText,
      type: "process-start",
      totalLines: fullText.split("\n").length,
      isHidden: false,
    };
  }

  let resultFormatted = "";
  let resultType: ToolResultText["type"] = "generic";

  // Check Bun Test output
  if (cleanText.includes("bun test") || cleanText.includes("(pass)") || cleanText.includes("(fail)") || cleanText.includes("Unhandled error between tests")) {
    resultFormatted = formatBunTestOutput(cleanText);
    resultType = "bun-test";
  }
  // Check Git status
  else if (/^\s*(?:[MADCU?!]{1,2})\s+\S+/m.test(cleanText)) {
    resultFormatted = formatGitStatusOutput(cleanText);
    resultType = "git-status";
  }
  // Check read_file header
  else if (cleanText.includes("[Reading ") && cleanText.includes("lines from start")) {
    resultFormatted = formatReadFileOutput(cleanText);
    resultType = "file-read";
  }
  // Check Grep / Code line numbers
  else if (/^\d+[:\-]\s*/m.test(cleanText)) {
    resultFormatted = formatGrepCodeOutput(cleanText);
    resultType = "code-grep";
  }
  // Check JSON (or stringified JSON dictionary/snapshot/OpenAPI response)
  else if (isJsonLike(cleanText)) {
    const parsed = tryParseJson(cleanText);
    if (parsed && typeof parsed === "object") {
      // 1. JSON Web / Text Snapshot (has text property)
      if (parsed.text && typeof parsed.text === "string") {
        resultFormatted = formatWebSnapshot(parsed);
        resultType = "web-snapshot";
      }
      // 2. Large API Response JSON dictionary / OpenAPI paths
      else {
        const prettyJson = JSON.stringify(parsed, null, 2);
        let highlighted = prettyJson;
        try {
          highlighted = highlight(prettyJson, { language: "json", ignoreIllegals: true });
        } catch {}
        resultFormatted = `${chalk.bold.cyan("📦 JSON Response:")}\n${highlighted}`;
        resultType = "json";
      }
    } else {
      resultFormatted = cleanGeneralLines(cleanText);
    }
  }
  // Check TS/JS code block
  else if (/\b(export|import|interface|type|const|function|return)\b/.test(cleanText) && cleanText.split("\n").length > 3) {
    try {
      resultFormatted = highlight(cleanText, { language: "typescript", ignoreIllegals: true });
      resultType = "code-grep";
    } catch {
      resultFormatted = cleanGeneralLines(cleanText);
    }
  }
  // Check Error
  else if (cleanText.toLowerCase().includes("error") || cleanText.includes("Unhandled") || cleanText.includes("Cannot find module") || cleanText.startsWith("Error:")) {
    resultFormatted = formatErrorText(cleanText);
    resultType = "error";
  } else {
    resultFormatted = cleanGeneralLines(cleanText);
  }

  const finalBody = noise ? `${noise}${resultFormatted}` : resultFormatted;
  const allLines = finalBody.split("\n");
  const totalLines = allLines.length;

  if (maxLines > 0 && totalLines > maxLines) {
    const keepCount = Math.max(4, maxLines - 3);
    const visibleLines = allLines.slice(0, keepCount).join("\n");
    const hiddenCount = totalLines - keepCount;

    const expandFooter = chalk.cyan.dim(`\n  ─── 🔍 ${hiddenCount} lines hidden (Press 'e' or 'Space' to expand, or --full) ───`);
    return {
      rawText: text,
      formattedText: `${visibleLines}${expandFooter}`,
      type: resultType,
      totalLines,
      isHidden: true,
    };
  }

  return {
    rawText: text,
    formattedText: finalBody,
    type: resultType,
    totalLines,
    isHidden: false,
  };
}

function stripNoiseHeaderLines(text: string): { noise: string; cleanText: string } {
  const lines = text.split("\n");
  const noiseLines: string[] = [];
  const contentLines: string[] = [];

  for (const line of lines) {
    if (line.includes("/Users/") && line.includes(".profile:") && line.includes("No such file or directory")) {
      noiseLines.push(line);
    } else {
      contentLines.push(line);
    }
  }

  return {
    noise: noiseLines.length > 0 ? noiseLines.map((l) => chalk.dim(l)).join("\n") + "\n" : "",
    cleanText: contentLines.join("\n").trim(),
  };
}

function isJsonLike(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function formatWebSnapshot(obj: { url?: string; title?: string; text?: string }): string {
  const parts: string[] = [];

  parts.push(chalk.bold.cyan("🌐 WEB PAGE / TEXT SNAPSHOT"));
  if (obj.title) {
    parts.push(`${chalk.bold("Title:")} ${chalk.white(obj.title)}`);
  }
  if (obj.url) {
    parts.push(`${chalk.bold("URL:")}   ${chalk.underline.blue(obj.url)}`);
  }

  if (obj.text) {
    const rawText = obj.text.replace(/\\n/g, "\n");
    const cleanText = rawText
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    parts.push(`\n${chalk.bold("📄 Page Content Preview:")}`);
    parts.push(chalk.gray(cleanText.join("\n")));
  }

  return parts.join("\n");
}

function formatGrepCodeOutput(raw: string): string {
  const lines = raw.split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(\d+)([:\-])(.*)$/);
    if (match) {
      const [, lineNum, sep, code] = match;
      const numFormatted = sep === ":" ? chalk.bold.yellow(`${lineNum}:`) : chalk.dim(`${lineNum}-`);

      let codeFormatted = code;
      try {
        codeFormatted = highlight(code, { language: "typescript", ignoreIllegals: true });
      } catch {}

      formatted.push(`${numFormatted} ${codeFormatted}`);
    } else if (line === "--") {
      formatted.push(chalk.dim.yellow("─── (separator) ───"));
    } else {
      formatted.push(cleanGeneralLines(line));
    }
  }

  return formatted.join("\n");
}

function formatBunTestOutput(raw: string): string {
  const lines = raw.split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    if (line.startsWith("bun test ")) {
      formatted.push(chalk.bold.magenta(`🧪 ${line}`));
    } else if (line.includes("(pass)")) {
      formatted.push(line.replace("(pass)", chalk.bold.green("  ✔ PASS")));
    } else if (line.includes("(fail)")) {
      formatted.push(line.replace("(fail)", chalk.bold.red("  ✖ FAIL")));
    } else if (line.includes("# Unhandled error")) {
      formatted.push(chalk.bgRed.white.bold(` ${line} `));
    } else if (line.startsWith("error:")) {
      formatted.push(chalk.red.bold(`  ⚠️ ${line}`));
    } else if (/^\s*\d+\s+(pass|fail|errors|expect\(\) calls)/.test(line)) {
      let l = line;
      l = l.replace(/(\d+)\s+pass/, (m, n) => chalk.bold.green(`${n} pass`));
      l = l.replace(/(\d+)\s+fail/, (m, n) => chalk.bold.red(`${n} fail`));
      l = l.replace(/(\d+)\s+errors/, (m, n) => chalk.bold.red(`${n} errors`));
      formatted.push(chalk.bold(`  📊 ${l.trim()}`));
    } else if (line.endsWith(".test.tsx:") || line.endsWith(".test.ts:") || line.endsWith(".test.js:")) {
      formatted.push(chalk.underline.bold.cyan(`\n📄 ${line}`));
    } else {
      formatted.push(line);
    }
  }

  return formatted.join("\n");
}

function formatGitStatusOutput(raw: string): string {
  const lines = raw.split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(\s*)([MADCU?!]{1,2})\s+(.+)$/);
    if (match) {
      const [, indent, status, filePath] = match;
      let statusColored = status;
      if (status.includes("M")) statusColored = chalk.bold.yellow("M");
      else if (status.includes("A")) statusColored = chalk.bold.green("A");
      else if (status.includes("D")) statusColored = chalk.bold.red("D");
      else if (status.includes("?")) statusColored = chalk.bold.gray("??");

      formatted.push(`${indent}${statusColored} ${filePath}`);
    } else {
      formatted.push(line);
    }
  }

  return formatted.join("\n");
}

function formatReadFileOutput(raw: string): string {
  const headerMatch = raw.match(/^\[Reading (\d+) lines from start \(total: (\d+) lines, (\d+) remaining\)\]/);
  if (!headerMatch) return raw;

  const [, readLines, totalLines, remaining] = headerMatch;
  const content = raw.replace(/^\[Reading [^\]]+\]\n\n?/, "");

  const meta = chalk.dim(`📖 Lines 1-${readLines} of ${totalLines} (${remaining} remaining)`);
  let highlightedContent = content;
  try {
    highlightedContent = highlight(content, { language: "typescript", ignoreIllegals: true });
  } catch {}

  return `${meta}\n\n${highlightedContent}`;
}

function formatErrorText(raw: string): string {
  const lines = raw.split("\n");
  const cleanedLines: string[] = [];

  for (const line of lines) {
    if (line.includes("node_modules/@modelcontextprotocol") || line.includes("node:internal/timers")) {
      cleanedLines.push(chalk.dim(line));
    } else if (line.includes("McpError") || line.includes("Error") || line.includes("failed") || line.includes("ENOENT")) {
      cleanedLines.push(chalk.bold.red(line));
    } else {
      cleanedLines.push(line);
    }
  }

  const baseErrorText = cleanedLines.join("\n");

  if (raw.includes("ENOENT") || raw.includes("no such file or directory")) {
    const hintBox = formatErrorHintAndSuggestions(raw);
    return `${baseErrorText}\n\n${hintBox}`;
  }

  return baseErrorText;
}

function cleanGeneralLines(raw: string): string {
  return raw;
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
