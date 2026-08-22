import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { TuiConnectionState, TuiSessionSource } from "../client/session-source";
import type { SessionStore } from "../session/store";
import type { SessionSnapshot } from "../session/types";
import { DesktopRemoteApp } from "./app";

export class TuiLifecycle {
  private stopPromise: Promise<void> | undefined;
  constructor(
    private readonly source: TuiSessionSource,
    private readonly destroy: () => void,
  ) {}

  start(refresh: () => void): Promise<void> {
    return this.source.start(refresh);
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    try {
      await this.source.stop();
    } finally {
      this.destroy();
    }
  }
}

export interface RunTuiOptions {
  store: SessionStore;
  source: TuiSessionSource;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const [snapshot, setSnapshot] = createSignal<SessionSnapshot>(options.store.snapshot());
  const [connectionState, setConnectionState] = createSignal<TuiConnectionState>(
    options.source.connectionState(),
  );
  let lifecycle: TuiLifecycle;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
  });

  lifecycle = new TuiLifecycle(options.source, () => renderer.destroy());
  let quitting = false;
  const refresh = () => {
    setSnapshot(options.store.snapshot());
    setConnectionState(options.source.connectionState());
  };
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    try {
      await lifecycle.stop();
    } finally {
      // TuiLifecycle owns renderer destruction.
    }
  };

  await render(
    () => <DesktopRemoteApp
      store={options.store}
      snapshot={snapshot}
      connectionState={connectionState}
      refresh={refresh}
      onQuit={quit}
    />,
    renderer,
  );

  refresh();
  void lifecycle.start(refresh).catch(async () => {
    refresh();
    await quit();
  });
}
