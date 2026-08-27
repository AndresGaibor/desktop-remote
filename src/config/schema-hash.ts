import { createHash } from "node:crypto";
import { toolSchemas, type OperationName } from "../mcp/schemas";
import type { ZodType } from "zod";

const schemas = toolSchemas as Readonly<Record<string, ZodType>>;

export interface SchemaHashDescription {
  current: string;
  stored: string;
  drift: boolean;
}

function serializeZodCanonical(schema: unknown): unknown {
  if (schema === null || schema === undefined) return null;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown> | undefined;
  if (!def) return null;
  const typeName = def.typeName as string;
  if (typeName === "ZodObject") {
    const rawShape = (schema as { shape?: unknown }).shape;
    const shape = typeof rawShape === "function"
      ? (rawShape as () => Record<string, unknown>)()
      : isRecord(rawShape)
        ? rawShape
        : undefined;
    if (!shape) return { typeName };
    const fields: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(shape)) {
      fields[key] = serializeZodCanonical(fieldSchema);
    }
    return { typeName, fields: sortObject(fields) };
  }
  if (typeName === "ZodArray") {
    return { typeName, inner: serializeZodCanonical(def.type) };
  }
  if (typeName === "ZodUnion") {
    return { typeName, options: (def.options as unknown[]).map(serializeZodCanonical) };
  }
  if (typeName === "ZodIntersection") {
    return {
      typeName,
      left: serializeZodCanonical(def.left),
      right: serializeZodCanonical(def.right),
    };
  }
  if (typeName === "ZodLiteral") {
    return { typeName, value: def.value };
  }
  if (typeName === "ZodEnum") {
    return { typeName, values: def.values };
  }
  if (typeName === "ZodOptional") {
    return { typeName, inner: serializeZodCanonical(def.inner) };
  }
  if (typeName === "ZodDefault") {
    return { typeName, inner: serializeZodCanonical(def.inner) };
  }
  if (typeName === "ZodRecord") {
    return {
      typeName,
      keyType: serializeZodCanonical(def.keyType),
      valueType: serializeZodCanonical(def.valueType),
    };
  }
  if (typeName === "ZodString") return { typeName };
  if (typeName === "ZodNumber") return { typeName };
  if (typeName === "ZodBoolean") return { typeName };
  if (typeName === "ZodNull") return { typeName };
  if (typeName === "ZodUnknown") return { typeName };
  return { typeName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const val = obj[key];
      acc[key] =
        typeof val === "object" && val !== null
          ? Array.isArray(val)
            ? val.map((v) => (typeof v === "object" && v !== null ? sortObject(v as Record<string, unknown>) : v))
            : sortObject(val as Record<string, unknown>)
          : val;
      return acc;
    }, {});
}

export function computeToolSchemaHash(): string {
  const sorted = (Object.keys(schemas) as OperationName[]).sort();
  const parts = sorted.map((name) => JSON.stringify({ name, schema: serializeZodCanonical(schemas[name]) }));
  return createHash("sha256").update(parts.join("")).digest("hex");
}

export function computePerToolSchemaHashes(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(schemas).sort()) {
    const canonical = JSON.stringify(serializeZodCanonical(schemas[name]));
    result[name] = createHash("sha256").update(canonical).digest("hex");
  }
  return result;
}

export function describeSchemaHash(current: string, stored: string): SchemaHashDescription {
  return { current, stored, drift: current !== stored };
}
