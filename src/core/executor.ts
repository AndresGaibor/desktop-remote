import { readTextFile, writeTextFile } from "../filesystem/files";
import { createDirectory, listDirectory, moveFile } from "../filesystem/directories";
import { editBlock } from "../filesystem/edit";
import { getFileInfo } from "../filesystem/info";
import { ProcessManager } from "../process/manager";
import { SearchManager } from "../search/manager";
import { readExcelFile, writeExcelFile, type ExcelMatrix } from "../formats/excel";
import { writePdfFile } from "../formats/pdf";
import { writeDocxFile } from "../formats/docx";

export class DesktopOperationExecutor {
  private readonly processes = new ProcessManager();
  private readonly searches: SearchManager;

  constructor(searches = new SearchManager()) {
    this.searches = searches;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === "read_file") {
      const path = requireString(input.path, "path");
      if (isExcelPath(path)) return { content: await readExcelFile(path), format: "excel" };
      return readTextFile(path, {
        offset: optionalInteger(input.offset, "offset"),
        length: optionalInteger(input.length, "length"),
      });
    }
    if (name === "write_file") {
      const path = requireString(input.path, "path");
      const content = requireString(input.content, "content");
      if (isExcelPath(path)) {
        await writeExcelFile(path, parseExcelContent(content));
        return { path, written: true, format: "excel" };
      }
      if (isPdfPath(path)) {
        await writePdfFile(path, content);
        return { path, written: true, format: "pdf" };
      }
      if (isDocxPath(path)) {
        await writeDocxFile(path, content);
        return { path, written: true, format: "docx" };
      }
      await writeTextFile(path, content);
      return { path, written: true };
    }
    if (name === "create_directory") return createDirectory(requireString(input.path, "path"));
    if (name === "list_directory") return listDirectory(requireString(input.path, "path"));
    if (name === "move_file") {
      return moveFile(requireString(input.source, "source"), requireString(input.destination, "destination"));
    }
    if (name === "get_file_info") return getFileInfo(requireString(input.path, "path"));
    if (name === "edit_block") {
      return editBlock(
        requireString(input.path ?? input.file_path, "path"),
        requireString(input.old_string, "old_string"),
        requireString(input.new_string, "new_string"),
      );
    }
    if (name === "start_process") return this.processes.start(requireStringArray(input.command, "command"));
    if (name === "read_process_output") return this.processes.readOutput(requireString(input.id, "id"));
    if (name === "start_search") {
      const mode = requireString(input.mode, "mode");
      if (mode !== "files" && mode !== "content") throw new Error("mode must be files or content");
      return this.searches.start({
        root: requireString(input.root, "root"),
        pattern: requireString(input.pattern, "pattern"),
        mode,
        maxResults: optionalNonNegativeInteger(input.maxResults, "maxResults"),
      });
    }
    if (name === "get_more_search_results") {
      return this.searches.getMore(
        requireString(input.id, "id"),
        requireNonNegativeInteger(input.offset, "offset"),
        requireNonNegativeInteger(input.length, "length"),
      );
    }
    if (name === "stop_search") {
      return this.searches.stop(requireString(input.id, "id"));
    }
    if (name === "list_searches") return this.searches.list();
    throw new Error(`Operation is not implemented: ${name}`);
  }
}

function isExcelPath(path: string): boolean {
  return /\.(xlsx|xls|xlsm)$/i.test(path);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function isDocxPath(path: string): boolean {
  return /\.docx$/i.test(path);
}

function parseExcelContent(content: string): ExcelMatrix {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Excel content must be valid JSON");
  }
  if (!Array.isArray(value) || value.some((row) => !Array.isArray(row))) {
    throw new Error("Excel content must be a 2D array");
  }
  return value as ExcelMatrix;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return [...value] as string[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  const integer = optionalInteger(value, field);
  if (integer !== undefined && integer < 0) throw new Error(`${field} must be a non-negative integer`);
  return integer;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (value === undefined) throw new Error(`${field} is required`);
  const integer = optionalNonNegativeInteger(value, field);
  return integer as number;
}
