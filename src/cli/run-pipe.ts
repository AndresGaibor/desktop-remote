import fs from "node:fs";
import readline from "node:readline";
import { LogFormatter } from "../formatter";
import { LogParser } from "../parser";

export interface RunPipeModeOptions {
  verbose: boolean;
  maxLines: number;
  saveLogPath?: string;
  input?: NodeJS.ReadableStream;
  output?: (text: string) => void;
}

export async function runPipeMode(options: RunPipeModeOptions): Promise<void> {
  const formatter = new LogFormatter({
    verbose: options.verbose,
    maxLines: options.maxLines,
  });
  const parser = new LogParser(formatter);
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? console.log;
  const logStream = options.saveLogPath
    ? fs.createWriteStream(options.saveLogPath, { flags: "a" })
    : undefined;

  const write = (text: string) => {
    output(text);
    logStream?.write(`${stripTerminalControl(text)}\n`);
  };

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input, terminal: false });

    rl.on("line", (line) => {
      const parsed = parser.parseLine(line);
      if (parsed) write(parsed.formattedText);
    });

    rl.on("close", () => {
      const flushed = parser.flush();
      if (flushed) write(flushed.formattedText);
      const summary = parser.formatSummary();
      if (summary) write(summary);

      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

    input.on("error", reject);
    logStream?.on("error", reject);
  });
}

function stripTerminalControl(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;.*?\u001b\\/g, "");
}
