import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { RuntimeEvent } from "../runtime/events";
import type { SessionStore } from "../session/store";
import type { SessionSnapshot } from "../session/types";
import { DesktopRemoteApp } from "./app";

export interface RuntimeController {
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  start(): void;
  stop(): Promise<void>;
}

export interface EventLogWriter {
  write(event: RuntimeEvent): void;
  close(): Promise<void>;
}

export interface TuiSessionBridgeOptions {
  runtime: RuntimeController;
  store: SessionStore;
  logWriter?: EventLogWriter;
}
export class TuiSessionBridge {
  private readonly runtime: RuntimeController;
  private readonly store: SessionStore;
  private readonly logWriter?: EventLogWriter;
  private unsubscribe: (() => void) | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: TuiSessionBridgeOptions) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.logWriter = options.logWriter;
  }

  start(refresh: () => void): void {
    if (this.unsubscribe) throw new Error("TUI session bridge already started");
    this.unsubscribe = this.runtime.onEvent((event) => {
      this.store.consume(event);
      this.logWriter?.write(event);
      refresh();
    });
    this.runtime.start();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    await this.runtime.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.logWriter?.close();
  }
}

export interface RunTuiOptions {
  runtime: RuntimeController;
  store: SessionStore;
  logWriter?: EventLogWriter;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const [snapshot, setSnapshot] = createSignal<SessionSnapshot>(options.store.snapshot());
  const bridge = new TuiSessionBridge(options);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
  });

  let quitting = false;
  const refresh = () => setSnapshot(options.store.snapshot());
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    try {
      await bridge.stop();
    } finally {
      renderer.destroy();
    }
  };

  await render(
    () => (
      <DesktopRemoteApp
        store={options.store}
        snapshot={snapshot}
        refresh={refresh}
        onQuit={quit}
      />
    ),
    renderer,
  );

  bridge.start(refresh);
  refresh();
}
