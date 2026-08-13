import { createWriteStream, type WriteStream } from "node:fs";
import type { RuntimeEvent } from "../runtime/events";
import { redactEvent } from "./redactor";

export class JsonlEventWriter {
  private readonly stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
  }

  write(event: RuntimeEvent): void {
    this.stream.write(`${JSON.stringify(redactEvent(event))}\n`);
  }

  async close(): Promise<void> {
    if (this.stream.closed) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.stream.once("error", onError);
      this.stream.end(() => {
        this.stream.off("error", onError);
        resolve();
      });
    });
  }
}

export async function readJsonlEvents(path: string): Promise<RuntimeEvent[]> {
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/);
  const events: RuntimeEvent[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRuntimeEventShape(parsed)) throw new Error("missing event type");
      events.push(parsed as RuntimeEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL event at line ${index + 1}: ${message}`);
    }
  }

  return events;
}

function isRuntimeEventShape(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null &&
    "type" in value && typeof (value as { type?: unknown }).type === "string";
}
