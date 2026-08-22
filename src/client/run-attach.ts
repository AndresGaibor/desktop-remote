import { DesktopRemoteIpcClient } from "./ipc-client";
import { IpcTuiSessionSource } from "./session-source";
import { SessionStore } from "../session/store";

export interface AttachTuiOptions {
  socketPath?: string;
  bunRuntime?: boolean;
  runTui?: (options: {
    store: SessionStore;
    source: IpcTuiSessionSource;
  }) => Promise<void>;
}

export interface AttachedTui {
  store: SessionStore;
  source: IpcTuiSessionSource;
}

export async function attachTui(options: AttachTuiOptions = {}): Promise<AttachedTui> {
  const bunRuntime = options.bunRuntime ?? typeof Bun !== "undefined";
  if (!bunRuntime && !options.runTui) {
    throw new Error("The OpenTUI client currently requires Bun; the daemon can run under Node.js");
  }

  const client = new DesktopRemoteIpcClient({ socketPath: options.socketPath });
  await client.connect("visual");
  const store = new SessionStore();
  const source = new IpcTuiSessionSource({
    store,
    createClient: () => client,
  });

  const runTui = options.runTui ?? await loadTui();
  try {
    await runTui({ store, source });
    return { store, source };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function loadTui(): Promise<NonNullable<AttachTuiOptions["runTui"]>> {
  const module = await import("../tui/run-tui");
  return module.runTui;
}
