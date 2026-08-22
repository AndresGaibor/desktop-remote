#!/usr/bin/env bun
import { attachTui } from "../src/client/run-attach";

try {
  await attachTui();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`desktop-remote attach: ${message}`);
  process.exitCode = 1;
}
