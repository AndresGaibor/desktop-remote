import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { writePdfFile } from "../../src/formats/pdf";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("escribe texto Markdown simple en un PDF válido", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-pdf-"));
  directories.push(directory);
  const path = join(directory, "nota.pdf");

  await writePdfFile(path, "# Título\n\nContenido **importante**.");

  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  await expect(PDFDocument.load(bytes)).resolves.toMatchObject({});
});
