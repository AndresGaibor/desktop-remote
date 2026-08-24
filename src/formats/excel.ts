import ExcelJS from "exceljs";

export type ExcelCell = string | number | boolean | null;
export type ExcelMatrix = ExcelCell[][];

export async function writeExcelFile(path: string, matrix: ExcelMatrix): Promise<void> {
  validateMatrix(matrix);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRows(matrix);
  await workbook.xlsx.writeFile(path);
}

export async function readExcelFile(path: string): Promise<ExcelMatrix> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const matrix: ExcelMatrix = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as unknown[];
    matrix.push(values.slice(1).map(normalizeCell));
  });
  return matrix;
}

function validateMatrix(matrix: ExcelMatrix): void {
  if (!Array.isArray(matrix) || matrix.some((row) => !Array.isArray(row))) {
    throw new Error("Excel content must be a 2D array");
  }
  if (matrix.some((row) => row.some((cell) => !isExcelCell(cell)))) {
    throw new Error("Excel cells must be strings, numbers, booleans, or null");
  }
}

function isExcelCell(value: unknown): value is ExcelCell {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeCell(value: unknown): ExcelCell {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null && "result" in value) {
    return normalizeCell((value as { result?: unknown }).result);
  }
  return isExcelCell(value) ? value : String(value);
}
