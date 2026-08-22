#!/usr/bin/env node
/**
 * Cross-runtime entry point for desktop-remote.
 *
 * - Under Bun: loads bin/cli.ts directly (Bun runs TypeScript natively).
 * - Under Node.js: registers tsx as an ESM loader, then loads bin/cli.ts.
 *
 * This wrapper lets `desktop-remote` run on machines where Bun cannot be
 * installed, as long as tsx is available (npm i -g tsx or npx tsx).
 */

const cliPath = new URL("./cli.ts", import.meta.url).href;

if (typeof Bun !== "undefined") {
  // Bun runs TypeScript natively — no loader registration needed.
  await import(cliPath);
} else {
  // Node.js: register tsx to handle .ts imports.
  let unregister;
  try {
    const tsx = await import("tsx/esm/api");
    unregister = tsx.register();
  } catch {
    console.error("desktop-remote requires its local tsx dependency when running under Node.js.");
    console.error("Run npm install (or use Bun) before starting desktop-remote.");
    process.exit(1);
  }
  try {
    await import(cliPath);
  } finally {
    unregister?.();
  }
}
