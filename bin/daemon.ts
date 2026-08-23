#!/usr/bin/env bun
import { runDaemon, parseDaemonDevArgs } from "../src/daemon/run-daemon";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--probe") {
  process.stdout.write("desktop-remote-daemon probe ok\n");
} else {
  const devArgs = parseDaemonDevArgs(argv);
  await runDaemon(devArgs);
}
