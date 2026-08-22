#!/usr/bin/env bun
import { runDaemon, parseDaemonDevArgs } from "../src/daemon/run-daemon";

const devArgs = parseDaemonDevArgs(process.argv.slice(2));

await runDaemon(devArgs);
