import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDocxFile } from "../../src/formats/docx";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("escribe texto en un DOCX válido", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-docx-"));
  directories.push(directory);
  const path = join(directory, "nota.docx");

  await writeDocxFile(path, "Título\n\nContenido del documento.");

  const bytes = await readFile(path);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.byteLength).toBeGreaterThan(100);
});
