import { open, rename as fsRename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export interface AtomicFileOps {
  rename?(source: string, destination: string): Promise<void>;
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  mode = 0o600,
  ops: AtomicFileOps = {},
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const handle = await open(tempPath, "wx", mode);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await (ops.rename ?? fsRename)(tempPath, path);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
