import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

export function requireSuccess(result: CommandResult, description: string): CommandResult {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`${description} failed: ${detail}`);
  }
  return result;
}

export async function resolveExecutable(name: string, envPath = process.env.PATH ?? ""): Promise<string | undefined> {
  if (name.startsWith("/")) {
    try { await access(name, constants.X_OK); return name; } catch { return undefined; }
  }
  for (const directory of envPath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}
