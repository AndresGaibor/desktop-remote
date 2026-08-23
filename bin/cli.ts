#!/usr/bin/env bun
import { createDefaultCliDependencies } from "../src/cli/default-deps";
import { runCli } from "../src/cli/main";

const code = await runCli(process.argv.slice(2), createDefaultCliDependencies());
if (code !== 0) process.exitCode = code;
