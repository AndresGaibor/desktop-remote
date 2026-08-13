#!/usr/bin/env bun
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { LogFormatter } from "../src/formatter";
import { getCommandToSpawn, getSpawnArgs } from "../src/launcher";
import { LogParser } from "../src/parser";
import type { CompactedBlockInfo } from "../src/parser";

const program = new Command();

program
  .name("desktop-remote")
  .description("A clean, beautifully formatted CLI runner for @wonderwhy-er/desktop-commander")
  .version("1.0.0")
  .option("-v, --verbose", "Show raw debug and stack trace logs")
  .option("-f, --full", "Show full, uncompacted output for long tool results")
  .option("-m, --max-lines <number>", "Max lines to display before compacting (default: 15, set 0 for full)", "15")
  .option("--cmd <command>", "Custom command to run instead of the installed desktop-commander executable")
  .option("--save-log <filepath>", "Save formatted output to a file")
  .allowUnknownOption(true)
  .action(async (options, commandObj) => {
    const isVerbose = !!options.verbose;
    const isFull = !!options.full;
    const maxLines = isFull ? 0 : parseInt(options.maxLines ?? "15", 10);
    const customCmd = options.cmd;
    const logFilePath = options.saveLog;
    const rawArgs = commandObj.args;

    const formatter = new LogFormatter({ verbose: isVerbose, maxLines });
    const parser = new LogParser(formatter);

    let logStream: fs.WriteStream | null = null;
    if (logFilePath) {
      logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    }

    const compactedStack: CompactedBlockInfo[] = [];

    function outputLog(text: string, isError = false) {
      if (isError) {
        console.error(text);
      } else {
        console.log(text);
      }
      if (logStream) {
        const plainText = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\]8;;.*?\u001b\\/g, "");
        logStream.write(plainText + "\n");
      }
    }

    // If stdin is piped (NOT a TTY)
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });

      rl.on("line", (line) => {
        const res = parser.parseLine(line);
        if (res !== null) {
          outputLog(res.formattedText);
          if (res.compactedInfo) compactedStack.push(res.compactedInfo);
        }
      });

      rl.on("close", () => {
        const flushed = parser.flush();
        if (flushed !== null) {
          outputLog(flushed.formattedText);
          if (flushed.compactedInfo) compactedStack.push(flushed.compactedInfo);
        }

        const summary = parser.formatSummary();
        if (summary !== null) outputLog(summary);

        if (logStream) logStream.end();
      });
      return;
    }

    // Interactive TTY Mode
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);

      process.stdin.on("keypress", (str, key) => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          process.exit(0);
        }

        // Space or 'e' expands the last compacted block
        if (key.name === "e" || str === " ") {
          if (compactedStack.length > 0) {
            const last = compactedStack.pop()!;
            console.log(chalk.bold.cyan(`\n📖 [EXPANDED VIEW: ${last.toolName}]`));
            const expanded = formatter.formatToolCompleted(last.toolName, last.rawText, last.durationMs, true);
            console.log(expanded);
          } else {
            console.log(chalk.dim("\n(No compacted blocks pending expansion)"));
          }
        }

        // 'a' expands ALL pending compacted blocks
        if (key.name === "a") {
          if (compactedStack.length > 0) {
            console.log(chalk.bold.cyan(`\n📖 [EXPANDING ALL ${compactedStack.length} BLOCKS]`));
            while (compactedStack.length > 0) {
              const item = compactedStack.shift()!;
              const expanded = formatter.formatToolCompleted(item.toolName, item.rawText, item.durationMs, true);
              console.log(expanded);
            }
          }
        }

        // 'c' clears terminal screen
        if (key.name === "c") {
          console.clear();
          console.log(chalk.dim("Terminal screen cleared.\n"));
        }
      });
    }

    const targetArgs = rawArgs.length > 0 ? rawArgs : ["remote", "--persist-session"];
    const cmdToSpawn = getCommandToSpawn(customCmd);
    const spawnArgs = getSpawnArgs(customCmd, targetArgs);

    outputLog(chalk.dim(`\n✨ Running: ${cmdToSpawn} ${spawnArgs.join(" ")}`));
    outputLog(chalk.bold.cyan(`⌨️  TUI Controls: [Space/e] Expand Last | [a] Expand All | [c] Clear Screen | [Ctrl+C] Exit\n`));

    // Spawn child with stdin ignored so process.stdin stays 100% available for keypress listener
    const child = spawn(cmdToSpawn, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutRemainder = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutRemainder + chunk.toString("utf-8");
      const lines = text.split("\n");
      stdoutRemainder = lines.pop() || "";

      for (const line of lines) {
        const res = parser.parseLine(line);
        if (res !== null) {
          outputLog(res.formattedText);
          if (res.compactedInfo) compactedStack.push(res.compactedInfo);
        }
      }
    });

    let stderrRemainder = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrRemainder + chunk.toString("utf-8");
      const lines = text.split("\n");
      stderrRemainder = lines.pop() || "";

      for (const line of lines) {
        if (!isVerbose && /^\s*at\s+/.test(line)) {
          continue;
        }
        const res = parser.parseLine(line);
        if (res !== null) {
          outputLog(res.formattedText, true);
          if (res.compactedInfo) compactedStack.push(res.compactedInfo);
        }
      }
    });

    child.on("close", (code) => {
      if (stdoutRemainder) {
        const res = parser.parseLine(stdoutRemainder);
        if (res !== null) outputLog(res.formattedText);
      }
      if (stderrRemainder) {
        const res = parser.parseLine(stderrRemainder);
        if (res !== null) outputLog(res.formattedText, true);
      }

      const flushed = parser.flush();
      if (flushed !== null) outputLog(flushed.formattedText);

      const summary = parser.formatSummary();
      if (summary !== null) outputLog(summary);

      if (logStream) logStream.end();

      if (code !== 0 && code !== null) {
        outputLog(chalk.red(`\nProcess exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  });

program.parse(process.argv);
