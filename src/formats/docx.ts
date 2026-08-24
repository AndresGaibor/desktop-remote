import { Document, Packer, Paragraph } from "docx";
import { writeFile } from "node:fs/promises";

export async function writeDocxFile(path: string, text: string): Promise<void> {
  if (typeof text !== "string") throw new Error("DOCX content must be text");
  const document = new Document({
    sections: [{ children: text.split(/\r?\n/).map((line) => new Paragraph({ text: stripMarkdown(line) })) }],
  });
  await writeFile(path, await Packer.toBuffer(document));
}

function stripMarkdown(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/[*_`~]/g, "");
}
