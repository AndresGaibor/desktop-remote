import { readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopRemotePaths } from "../platform/paths";

export async function readDaemonLogs(paths: DesktopRemotePaths, follow: boolean, write: (text: string) => void): Promise<void> {
  const files = ["daemon.log.2", "daemon.log.1", "daemon.log"];
  for (const name of files) {
    try { write(await readFile(join(paths.logsDir, name), "utf8")); } catch (error) { if (!isEnoent(error)) throw error; }
  }
  if (!follow) return;
  let offset = await sizeOf(join(paths.logsDir, "daemon.log"));
  const watcher = watch(paths.logsDir, { persistent: true });
  for await (const event of watcher) {
    if (event.filename !== "daemon.log") continue;
    const path = join(paths.logsDir, "daemon.log");
    try {
      const text = await readFile(path, "utf8");
      if (text.length < offset) offset = 0;
      if (text.length > offset) write(text.slice(offset));
      offset = text.length;
    } catch (error) { if (!isEnoent(error)) throw error; }
  }
}
async function sizeOf(path: string): Promise<number> { try { return (await readFile(path, "utf8")).length; } catch { return 0; } }
function isEnoent(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
