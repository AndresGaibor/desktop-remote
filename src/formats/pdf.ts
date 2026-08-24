import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function writePdfFile(path: string, markdown: string): Promise<void> {
  if (typeof markdown !== "string") throw new Error("PDF content must be text");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const lines = markdownToLines(markdown);
  let page = document.addPage();
  let y = page.getHeight() - 54;
  for (const line of lines) {
    if (y < 48) {
      page = document.addPage();
      y = page.getHeight() - 54;
    }
    page.drawText(line, { x: 54, y, size: 12, font, color: rgb(0, 0, 0) });
    y -= 18;
  }
  await writeFile(path, await document.save());
}

function markdownToLines(markdown: string): string[] {
  const lines = markdown.replace(/[*_`~]/g, "").split(/\r?\n/);
  return lines.map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "• "));
}
