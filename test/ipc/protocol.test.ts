import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
} from "../../src/ipc/protocol";

describe("IPC protocol", () => {
  test("accepts version-1 client messages", () => {
    expect(parseClientMessage({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: "visual",
    })).toEqual({ type: "hello", protocolVersion: 1, client: "visual" });
    expect(parseClientMessage({ type: "ping", protocolVersion: 1, at: 42 }))
      .toMatchObject({ type: "ping", at: 42 });
    expect(parseClientMessage({
      type: "operation.request",
      protocolVersion: 1,
      requestId: "op-1",
      name: "read_file",
      input: { path: "/tmp/example" },
    })).toEqual({
      type: "operation.request",
      protocolVersion: 1,
      requestId: "op-1",
      name: "read_file",
      input: { path: "/tmp/example" },
    });
  });

  test("rejects wrong client protocol versions and unknown message types", () => {
    expect(() => parseClientMessage({ type: "hello", protocolVersion: 2, client: "visual" }))
      .toThrow(/protocol version/i);
    expect(() => parseClientMessage({ type: "mystery", protocolVersion: 1 }))
      .toThrow(/unknown client message/i);
  });

  test("accepts and validates version-1 server messages", () => {
    expect(parseServerMessage({ type: "hello.ack", protocolVersion: 1, daemonPid: 123 }))
      .toEqual({ type: "hello.ack", protocolVersion: 1, daemonPid: 123 });
    expect(parseServerMessage({ type: "attached", protocolVersion: 1, attachedSince: 44 }))
      .toEqual({ type: "attached", protocolVersion: 1, attachedSince: 44 });
    expect(() => parseServerMessage({ type: "hello.ack", protocolVersion: 9, daemonPid: 123 }))
      .toThrow(/protocol version/i);
    expect(() => parseServerMessage({ type: "unknown", protocolVersion: 1 }))
      .toThrow(/unknown server message/i);
    expect(parseServerMessage({
      type: "operation.response",
      protocolVersion: 1,
      requestId: "op-1",
      result: { contents: [] },
    })).toEqual({
      type: "operation.response",
      protocolVersion: 1,
      requestId: "op-1",
      result: { contents: [] },
    });
  });
});
