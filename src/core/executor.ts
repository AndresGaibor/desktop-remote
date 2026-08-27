import { appendTextFile, readTextFile, readUrl, writeTextFile } from "../filesystem/files";
import { createDirectory, listDirectory, moveFile, DEFAULT_DIRECTORY_PAGE_SIZE } from "../filesystem/directories";
import { editBlock } from "../filesystem/edit";
import { getFileInfo } from "../filesystem/info";
import { ProcessManager } from "../process/manager";
import { SearchManager } from "../search/manager";
import { readExcelFile, writeExcelFile, type ExcelMatrix } from "../formats/excel";
import { writePdfFile } from "../formats/pdf";
import { writeDocxFile } from "../formats/docx";
import { ConfigStore } from "../config/store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeToolCall } from "../telemetry/tool-call-summary";
import {
  classifyOperation,
  OperationScheduler,
  type OperationScheduleOptions,
  type OperationSchedulerSnapshot,
} from "./operation-scheduler";

export interface DesktopOperationExecutionOptions extends OperationScheduleOptions {
  traceId?: string;
}

export class DesktopOperationExecutor {
  private readonly processes = new ProcessManager();
  private readonly searches: SearchManager;

  private readonly configStore: ConfigStore;
  private readonly scheduler: OperationScheduler;

  constructor(searches = new SearchManager(), configStore?: ConfigStore, scheduler = new OperationScheduler()) {
    this.searches = searches;
    this.configStore = configStore ?? new ConfigStore(join(tmpdir(), `desktop-remote-${process.pid}.json`));
    this.scheduler = scheduler;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: DesktopOperationExecutionOptions,
  ): Promise<unknown> {
    return this.scheduler.run(
      classifyOperation(name, input),
      () => this.executeScheduled(name, input, options),
      options,
    );
  }

  getSchedulerSnapshot(): OperationSchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  private async executeScheduled(
    name: string,
    input: Record<string, unknown>,
    options?: DesktopOperationExecutionOptions,
  ): Promise<unknown> {
    if (name === "get_config") return this.configStore.getConfig();
    if (name === "set_config_value") return this.configStore.setConfigValue(requireString(input.key, "key"), input.value);
    if (name === "get_usage_stats") return this.configStore.getUsageStats();
    if (name === "get_recent_tool_calls") return this.configStore.getRecentToolCalls(input as { maxResults?: number; toolName?: string; since?: string });
    const startedAt = new Date();
    try {
      const result = await this.executeTool(name, input);
      await this.recordBestEffort(name, input, { result }, startedAt, options);
      return result;
    } catch (error) {
      await this.recordBestEffort(name, input, { error: error instanceof Error ? error.message : String(error) }, startedAt, options);
      throw error;
    }
  }

  private async recordBestEffort(
    name: string,
    input: Record<string, unknown>,
    partial: { result?: unknown; error?: string },
    startedAt: Date,
    options?: { traceId?: string },
  ): Promise<void> {
    try {
      const summary = summarizeToolCall(name, input, partial.result, partial.error);
      await this.configStore.recordToolCall({
        toolName: name,
        arguments: summary.arguments,
        ...(summary.result === undefined ? {} : { result: summary.result }),
        ...(summary.error === undefined ? {} : { error: summary.error }),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ...(options?.traceId !== undefined ? { traceId: options.traceId } : {}),
      });
    } catch {
      // La telemetría es best-effort: un fallo de persistencia nunca debe
      // cambiar la semántica operacional (ni enmascarar el error original).
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === "read_file") {
      const path = requireString(input.path, "path");
      const readOptions = {
        offset: optionalNonNegativeInteger(input.offset, "offset"),
        length: optionalInteger(input.length, "length"),
      };
      if (input.isUrl === true) return readUrl(path, readOptions);
      if (isExcelPath(path)) return { content: await readExcelFile(path), format: "excel" };
      return readTextFile(path, readOptions);
    }
    if (name === "read_multiple_files") {
      const paths = requireStringArray(input.paths, "paths");
      const files = await Promise.all(paths.map(async (path) => ({
        path,
        ...(input.isUrl === true ? await readUrl(path) : await readTextFile(path)),
      })));
      return { files };
    }
    if (name === "write_file") {
      const path = requireString(input.path, "path");
      const content = requireString(input.content, "content");
      if (input.mode === "append") {
        if (isExcelPath(path) || isPdfPath(path) || isDocxPath(path)) {
          throw new Error("append mode is only supported for text files");
        }
        await appendTextFile(path, content);
        return { path, written: true, mode: "append" };
      }
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
    if (name === "write_pdf") {
      const path = requireString(input.outputPath ?? input.path, "path");
      const content = typeof input.content === "string" ? input.content : JSON.stringify(input.content);
      await writePdfFile(path, content);
      return { path, written: true, format: "pdf" };
    }
    if (name === "create_directory") return createDirectory(requireString(input.path, "path"));
    if (name === "list_directory") {
      return listDirectory(
        requireString(input.path, "path"),
        optionalNonNegativeInteger(input.depth, "depth") ?? 2,
        {
          cursor: optionalString(input.cursor, "cursor"),
          limit: optionalPositiveInteger(input.limit, "limit") ?? DEFAULT_DIRECTORY_PAGE_SIZE,
        },
      );
    }
    if (name === "move_file") {
      return moveFile(requireString(input.source, "source"), requireString(input.destination, "destination"));
    }
    if (name === "get_file_info") return getFileInfo(requireString(input.path, "path"));
    if (name === "edit_block") {
      const range = input.range === undefined ? undefined : requireEditRange(input.range);
      const content = input.content === undefined ? undefined : requireStringValue(input.content, "content");
      return editBlock(
        requireString(input.path ?? input.file_path, "path"),
        input.old_string === undefined ? undefined : requireString(input.old_string, "old_string"),
        input.new_string === undefined ? undefined : requireStringValue(input.new_string, "new_string"),
        {
          ...(range === undefined ? {} : { range }),
          ...(content === undefined ? {} : { content }),
          ...(input.expected_replacements === undefined
            ? {}
            : { expected_replacements: requirePositiveInteger(input.expected_replacements, "expected_replacements") }),
          ...(input.expected_sha256 === undefined
            ? {}
            : { expected_sha256: requireString(input.expected_sha256, "expected_sha256") }),
        },
      );
    }
    if (name === "start_process") {
      const command = typeof input.command === "string"
        ? requireString(input.command, "command")
        : requireStringArray(input.command, "command");
      return this.processes.start(command, {
        shell: optionalString(input.shell, "shell"),
        cwd: optionalString(input.cwd, "cwd"),
        env: optionalEnvironment(input.env, "env"),
        timeout_ms: optionalPositiveInteger(input.timeout_ms, "timeout_ms") ?? 30000,
      });
    }
    if (name === "read_process_output") {
      return this.processes.readOutput(
        input.pid === undefined ? requireString(input.id, "id") : requirePositiveInteger(input.pid, "pid"),
        {
          timeout_ms: optionalPositiveInteger(input.timeout_ms, "timeout_ms"),
          offset: optionalNonNegativeInteger(input.offset, "offset"),
          length: optionalPositiveInteger(input.length, "length"),
          stdout_offset: optionalNonNegativeInteger(input.stdout_offset, "stdout_offset"),
          stdout_length: optionalPositiveInteger(input.stdout_length, "stdout_length"),
          stderr_offset: optionalNonNegativeInteger(input.stderr_offset, "stderr_offset"),
          stderr_length: optionalPositiveInteger(input.stderr_length, "stderr_length"),
        },
      );
    }
    if (name === "interact_with_process") {
      return this.processes.interact(
        requirePositiveInteger(input.pid, "pid"),
        typeof input.input === "string" ? input.input : requireString(input.input, "input"),
        {
          timeout_ms: optionalPositiveInteger(input.timeout_ms, "timeout_ms"),
          wait_for_prompt: input.wait_for_prompt === undefined
            ? undefined
            : requireBoolean(input.wait_for_prompt, "wait_for_prompt"),
        },
      );
    }
    if (name === "force_terminate") return this.processes.terminate(requirePositiveInteger(input.pid, "pid"));
    if (name === "list_sessions") return this.processes.listSessions();
    if (name === "list_processes") return this.processes.listProcesses();
    if (name === "kill_process") return this.processes.kill(requirePositiveInteger(input.pid, "pid"));
    if (name === "start_search") {
      return this.searches.start({
        path: requireString(input.path, "path"),
        pattern: requireString(input.pattern, "pattern"),
        searchType: input.searchType === undefined ? "files" : requireSearchType(input.searchType),
        filePattern: optionalString(input.filePattern, "filePattern"),
        ignoreCase: input.ignoreCase === undefined ? true : requireBoolean(input.ignoreCase, "ignoreCase"),
        maxResults: optionalNonNegativeInteger(input.maxResults, "maxResults"),
        includeHidden: input.includeHidden === undefined
          ? false
          : requireBoolean(input.includeHidden, "includeHidden"),
        contextLines: optionalNonNegativeInteger(input.contextLines, "contextLines") ?? 5,
        timeout_ms: optionalPositiveInteger(input.timeout_ms, "timeout_ms"),
        earlyTermination: input.earlyTermination === undefined
          ? undefined
          : requireBoolean(input.earlyTermination, "earlyTermination"),
        literalSearch: input.literalSearch === undefined
          ? false
          : requireBoolean(input.literalSearch, "literalSearch"),
      });
    }
    if (name === "get_more_search_results") {
      return this.searches.getMore(
        requireString(input.sessionId, "sessionId"),
        input.offset === undefined ? 0 : requireNonNegativeInteger(input.offset, "offset"),
        input.length === undefined ? 100 : requireNonNegativeInteger(input.length, "length"),
      );
    }
    if (name === "stop_search") {
      return this.searches.stop(requireString(input.sessionId, "sessionId"));
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
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return [...value] as string[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireStringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function requireEditRange(value: unknown): { start: number; end: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("range must be an object");
  }
  const range = value as { start?: unknown; end?: unknown };
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) {
    throw new Error("range start and end must be integers");
  }
  return { start: range.start as number, end: range.end as number };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalEnvironment(value: unknown, field: string): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const environment: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key) throw new Error(`${field} contains an invalid variable name`);
    if (typeof entry !== "string" && entry !== null) throw new Error(`${field}.${key} must be a string or null`);
    environment[key] = entry;
  }
  return environment;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requireSearchType(value: unknown): "files" | "content" {
  if (value !== "files" && value !== "content") throw new Error("searchType must be files or content");
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  const integer = optionalInteger(value, field);
  if (integer !== undefined && integer <= 0) throw new Error(`${field} must be a positive integer`);
  return integer;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const integer = optionalPositiveInteger(value, field);
  if (integer === undefined) throw new Error(`${field} is required`);
  return integer;
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
