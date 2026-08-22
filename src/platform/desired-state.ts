import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomicJson } from "./atomic-file";

export type DesiredState = "running" | "stopped";

export async function readDesiredState(path: string): Promise<DesiredState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "running";
    throw error;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || (value.state !== "running" && value.state !== "stopped")) {
      throw new Error("invalid value");
    }
    return value.state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Desktop Remote desired state: ${message}`);
  }
}

export async function writeDesiredState(path: string, state: DesiredState): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await writeAtomicJson(path, { state }, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
