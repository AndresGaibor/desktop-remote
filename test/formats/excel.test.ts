import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExcelFile, writeExcelFile } from "../../src/formats/excel";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("escribe y lee una matriz 2D en un archivo Excel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-excel-"));
  directories.push(directory);
  const path = join(directory, "datos.xlsx");
  const matrix = [["Nombre", "Edad"], ["Ana", 32], ["Luis", 28]];

  await writeExcelFile(path, matrix);

  await expect(readExcelFile(path)).resolves.toEqual(matrix);
});
