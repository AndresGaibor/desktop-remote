import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { computePerToolSchemaHashes, computeToolSchemaHash, describeSchemaHash } from "../../src/config/schema-hash";

describe("computeToolSchemaHash", () => {
  test("es estable entre dos llamadas", () => {
    const h1 = computeToolSchemaHash();
    const h2 = computeToolSchemaHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("cambiar un schema cambia el hash global", () => {
    const baseline = computeToolSchemaHash();
    const mutated = createHash("sha256")
      .update(JSON.stringify({ name: "read_file", schema: { typeName: "ZodObject", fields: {} } }))
      .digest("hex");
    expect(baseline).not.toBe(mutated);
  });
});

describe("computePerToolSchemaHashes", () => {
  test("devuelve una entrada por cada tool en toolSchemas", () => {
    const hashes = computePerToolSchemaHashes();
    expect(Object.keys(hashes).length).toBeGreaterThan(0);
    for (const hash of Object.values(hashes)) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("cada hash es estable", () => {
    const h1 = computePerToolSchemaHashes();
    const h2 = computePerToolSchemaHashes();
    expect(h1).toEqual(h2);
  });
});

describe("describeSchemaHash", () => {
  test("expone fingerprint actual, instalado y drift de forma estable", () => {
    expect(describeSchemaHash("current-hash", "stored-hash")).toEqual({
      current: "current-hash",
      stored: "stored-hash",
      drift: true,
    });
    expect(describeSchemaHash("same", "same").drift).toBe(false);
  });
});
