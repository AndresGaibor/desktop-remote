import { describe, expect, test } from "bun:test";
import { createOperationHandler } from "../../src/mcp/handler";

describe("MCP operation handler", () => {
  test("returns structured MCP content from the daemon operation executor", async () => {
    const handler = createOperationHandler({
      execute: async (name, input) => ({ name, input }),
    });

    await expect(handler("read_file", { path: "/tmp/example" })).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ name: "read_file", input: { path: "/tmp/example" } }) }],
      structuredContent: { name: "read_file", input: { path: "/tmp/example" } },
    });
  });

  test("converts executor errors to MCP tool errors", async () => {
    const handler = createOperationHandler({
      execute: async () => { throw new Error("daemon unavailable"); },
    });

    await expect(handler("read_file", {})).resolves.toEqual({
      content: [{ type: "text", text: "daemon unavailable" }],
      isError: true,
    });
  });
  test("omits structured content when the executor has no structured result", async () => {
    const handler = createOperationHandler({ execute: async () => undefined });

    await expect(handler("stop_search", { sessionId: "search-1" })).resolves.toEqual({
      content: [{ type: "text", text: "" }],
    });
  });
});
