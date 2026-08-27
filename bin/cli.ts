#!/usr/bin/env bun
import { createDefaultCliDependencies } from "../src/cli/default-deps";
import { runCli } from "../src/cli/main";

// El preload de SolidJS registra el transform de JSX de Solid y es Bun-only:
// lanza bajo Node. Solo se necesita para `attach`/`replay` (la TUI en .tsx),
// que lo importan de forma diferida. Lo cargamos aquí, antes de que `runCli`
// despache esos comandos, pero EXCLUSIVAMENTE bajo Bun y para la TUI — nunca
// durante el bootstrap administrativo/daemon bajo Node, que debe seguir siendo
// compatible con Node según el contrato del proyecto.
const subcommand = process.argv[2];
if (typeof Bun !== "undefined" && (subcommand === "attach" || subcommand === "replay")) {
  await import("@opentui/solid/preload");
}

const code = await runCli(process.argv.slice(2), createDefaultCliDependencies());
if (code !== 0) process.exitCode = code;
