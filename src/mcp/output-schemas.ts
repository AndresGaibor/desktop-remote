import { z } from "zod";

const textPage = z.object({
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});

const excelCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const excelMatrix = z.array(z.array(excelCell));
const config = z.object({
  blockedCommands: z.array(z.string()),
  defaultShell: z.string(),
  allowedDirectories: z.array(z.string()),
  fileReadLineLimit: z.number().int().positive(),
  fileWriteLineLimit: z.number().int().positive(),
  telemetryEnabled: z.boolean(),
});

const processStatus = z.enum(["running", "completed", "failed"]);
const processCursor = z.object({
  offset: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
const processOutput = z.object({
  id: z.string(),
  pid: z.number().int().positive(),
  cwd: z.string(),
  status: processStatus,
  output: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  outputBytes: z.number().int().nonnegative(),
  outputRetainedBytes: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stdoutRetainedBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stderrRetainedBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
  truncated: z.boolean(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  outputCursor: processCursor,
  stdoutCursor: processCursor,
  stderrCursor: processCursor,
  timedOut: z.boolean().optional(),
  exitCode: z.number().int().optional(),
});

const contentSearchMatch = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  match: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});

const toolCallRecord = z.object({
  toolName: z.string(),
  arguments: z.unknown(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
});

export const outputSchemas = {
  get_config: config,
  set_config_value: config,
  get_usage_stats: z.object({
    totalCalls: z.number().int().nonnegative(),
    successfulCalls: z.number().int().nonnegative(),
    failedCalls: z.number().int().nonnegative(),
    byTool: z.record(z.string(), z.number().int().nonnegative()),
  }),
  get_recent_tool_calls: z.array(toolCallRecord),

  read_file: z.union([
    textPage,
    z.object({ content: excelMatrix, format: z.literal("excel") }),
  ]),
  read_multiple_files: z.object({
    files: z.array(z.object({ path: z.string() }).and(textPage)),
  }),
  write_file: z.object({
    path: z.string(),
    written: z.literal(true),
    mode: z.literal("append").optional(),
    format: z.enum(["excel", "pdf", "docx"]).optional(),
  }),
  write_pdf: z.object({ path: z.string(), written: z.literal(true), format: z.literal("pdf") }),
  create_directory: z.object({ path: z.string(), created: z.literal(true) }),
  list_directory: z.array(z.object({
    name: z.string(),
    type: z.enum(["file", "directory", "symlink"]),
  })),
  move_file: z.object({ source: z.string(), destination: z.string(), moved: z.literal(true) }),
  get_file_info: z.object({
    path: z.string(),
    size: z.number().nonnegative(),
    createdAt: z.string(),    modifiedAt: z.string(),
    accessedAt: z.string(),
    isFile: z.boolean(),
    isDirectory: z.boolean(),
    isSymbolicLink: z.boolean(),
  }),
  edit_block: z.object({ path: z.string(), edited: z.literal(true) }),

  start_search: z.object({
    id: z.string(),
    sessionId: z.string(),
    status: z.enum(["running", "completed"]),
  }),
  get_more_search_results: z.object({
    id: z.string(),
    sessionId: z.string(),
    results: z.array(z.union([z.string(), contentSearchMatch])),
    total: z.number().int().nonnegative(),
    done: z.boolean(),
    truncated: z.boolean().optional(),
  }),
  stop_search: undefined,
  list_searches: z.array(z.object({ id: z.string(), status: z.string() })),

  start_process: z.object({ id: z.string(), pid: z.number().int().positive(), cwd: z.string() }),
  read_process_output: processOutput,
  interact_with_process: processOutput,
  force_terminate: z.object({ pid: z.number().int().positive(), terminated: z.literal(true) }),
  list_sessions: z.array(processOutput),
  list_processes: z.array(z.object({
    pid: z.number().int().positive(),
    ppid: z.number().int().nonnegative(),
    stat: z.string(),
    command: z.string(),
  })),
  kill_process: z.object({ pid: z.number().int().positive(), killed: z.literal(true) }),
} as const;
