#!/usr/bin/env bun
import { parseDaemonDevArgs, runDaemon } from "../src/daemon/run-daemon";

try {
  const options = parseDaemonDevArgs(process.argv.slice(2));
  await runDaemon(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`desktop-remote daemon: ${message}`);
  process.exitCode = 1;
}
