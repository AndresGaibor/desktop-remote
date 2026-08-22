import { expect, test } from "bun:test";
import type {
  TuiConnectionState,
  TuiSessionSource,
} from "../../src/client/session-source";
import { TuiLifecycle } from "../../src/tui/run-tui";

class FakeSource implements TuiSessionSource {
  starts = 0;
  stops = 0;
  state: TuiConnectionState = "connected";

  async start(refresh: () => void): Promise<void> {
    this.starts += 1;
    refresh();
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.state = "stopped";
  }

  connectionState(): TuiConnectionState {
    return this.state;
  }
}

test("TuiLifecycle owns only the disposable session source", async () => {
  const source = new FakeSource();
  let refreshes = 0;
  let destroys = 0;
  const lifecycle = new TuiLifecycle(source, () => { destroys += 1; });

  await lifecycle.start(() => { refreshes += 1; });
  await lifecycle.stop();
  await lifecycle.stop();

  expect(source.starts).toBe(1);
  expect(source.stops).toBe(1);
  expect(refreshes).toBe(1);
  expect(destroys).toBe(1);
});
