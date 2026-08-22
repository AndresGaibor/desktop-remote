import { sleep as defaultSleep } from "../platform/runtime";
import type { RuntimeEvent } from "../runtime/events";
import { SESSION_HISTORY_LIMIT } from "../session/bounds";
import type { SessionStore } from "../session/store";
import type { RuntimeSessionSnapshot } from "../session/types";

export interface SessionIpcClient {
  connect(mode: "visual" | "admin"): Promise<void>;
  requestSnapshot(): Promise<RuntimeSessionSnapshot>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

export const TUI_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type TuiConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface TuiSessionSource {
  start(refresh: () => void): Promise<void>;
  stop(): Promise<void>;
  connectionState(): TuiConnectionState;
}

export interface IpcTuiSessionSourceOptions {
  store: SessionStore;
  createClient: () => SessionIpcClient;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
export class IpcTuiSessionSource implements TuiSessionSource {
  private readonly store: SessionStore;
  private readonly createClient: () => SessionIpcClient;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private client: SessionIpcClient | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private unsubscribeDisconnect: (() => void) | undefined;
  private state: TuiConnectionState = "disconnected";
  private generation = 0;
  private reconnectIndex = 0;
  private refresh: (() => void) | undefined;
  private retryAbort: AbortController | undefined;

  constructor(options: IpcTuiSessionSourceOptions) {
    this.store = options.store;
    this.createClient = options.createClient;
    this.sleep = options.sleep ?? defaultSleep;
  }

  connectionState(): TuiConnectionState {
    return this.state;
  }

  async start(refresh: () => void): Promise<void> {
    if (this.state !== "disconnected") throw new Error("Session source already started");
    this.refresh = refresh;
    const generation = ++this.generation;
    await this.connectLoop(generation, true);
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.retryAbort?.abort();
    this.retryAbort = undefined;
    this.setState("stopped");
    const client = this.client;
    this.detachClient();
    this.client = undefined;
    if (client) await client.close();
  }
  private async connectLoop(generation: number, initial: boolean): Promise<void> {
    let firstAttempt = initial;
    while (generation === this.generation && this.state !== "stopped") {
      this.setState(firstAttempt ? "connecting" : "reconnecting");
      try {
        await this.connectClient(generation);
        return;
      } catch {
        if (generation !== this.generation) return;
        this.setState("reconnecting");
        const delayMs = TUI_RECONNECT_DELAYS_MS[
          Math.min(this.reconnectIndex, TUI_RECONNECT_DELAYS_MS.length - 1)
        ] ?? 30_000;
        this.reconnectIndex += 1;
        const retryAbort = new AbortController();
        this.retryAbort?.abort();
        this.retryAbort = retryAbort;
        await this.sleep(delayMs, retryAbort.signal);
        if (this.retryAbort === retryAbort) this.retryAbort = undefined;
        if (generation !== this.generation) return;
        firstAttempt = false;
      }
    }
  }

  private async connectClient(generation: number): Promise<void> {
    const client = this.createClient();
    this.client = client;
    const pendingEvents: RuntimeEvent[] = [];
    let synchronized = false;
    let unsubscribeEvents: (() => void) | undefined;

    try {
      await client.connect("visual");
      if (generation !== this.generation) throw new Error("stale session generation");
      unsubscribeEvents = client.subscribe((event) => {
        if (generation !== this.generation || this.client !== client) return;
        if (!synchronized) {
          pendingEvents.push(event);
          if (pendingEvents.length > SESSION_HISTORY_LIMIT) pendingEvents.shift();
          return;
        }
        this.applyEvent(event);
      });
      const snapshot = await client.requestSnapshot();
      if (generation !== this.generation) throw new Error("stale session generation");

      this.store.replaceRuntime(snapshot);
      for (const event of pendingEvents) this.store.consume(event);
      synchronized = true;
      this.unsubscribeEvents = unsubscribeEvents;
      this.unsubscribeDisconnect = client.onDisconnect(() => this.handleDisconnect(client, generation));
      this.reconnectIndex = 0;
      this.setState("connected");
      this.refresh?.();
    } catch (error) {
      unsubscribeEvents?.();
      if (this.client === client) this.client = undefined;
      await client.close();
      throw error;
    }
  }
  private handleDisconnect(client: SessionIpcClient, generation: number): void {
    if (generation !== this.generation || this.client !== client || this.state === "stopped") return;
    this.detachClient();
    this.client = undefined;
    void client.close();
    this.reconnectIndex = 0;
    this.setState("reconnecting");
    const nextGeneration = ++this.generation;
    void this.connectLoop(nextGeneration, false);
  }

  private applyEvent(event: RuntimeEvent): void {
    if (this.state !== "connected") return;
    this.store.consume(event);
    this.refresh?.();
  }

  private detachClient(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = undefined;
  }

  private setState(state: TuiConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.refresh?.();
  }
}
