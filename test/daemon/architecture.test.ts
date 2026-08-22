import { expect, test } from "bun:test";

test("daemon modules never import OpenTUI, Solid, or TUI source", async () => {
  for await (const file of new Bun.Glob("src/daemon/**/*.{ts,tsx}").scan(".")) {
    const text = await Bun.file(file).text();
    expect(text).not.toMatch(/@opentui\/|solid-js|(?:^|\/)tui\//m);
  }
});
