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
    expect(() => parseServerMessage({ type: "hello.ack", protocolVersion: 9, daemonPid: 123 }))
      .toThrow(/protocol version/i);
    expect(() => parseServerMessage({ type: "unknown", protocolVersion: 1 }))
      .toThrow(/unknown server message/i);
  });
});
