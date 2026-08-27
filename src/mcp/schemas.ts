import { z } from "zod";

export const toolSchemas = {
  get_config: z.object({
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  set_config_value: z.object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.string().array(), z.null()]),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  start_process: z.object({
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().default(30000),
    shell: z.string().optional(),
  }),

  read_process_output: z.object({
    pid: z.number().int().positive(),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().optional(),
  }),

  interact_with_process: z.object({
    pid: z.number().int().positive(),
    input: z.string(),
    wait_for_prompt: z.boolean().optional(),
  }),

  force_terminate: z.object({ pid: z.number().int().positive() }),

  list_sessions: z.object({}),

  list_processes: z.object({}),

  kill_process: z.object({ pid: z.number().int().positive() }),

  read_file: z.object({
    path: z.string().min(1),
    isUrl: z.boolean().optional().default(false),
    offset: z.number().int().nonnegative().optional().default(0),
    length: z.number().int().positive().optional().default(1000),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  read_multiple_files: z.object({ paths: z.array(z.string().min(1)).min(1) }),

  write_file: z.object({
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional().default("rewrite"),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  write_pdf: z.object({
    path: z.string().min(1),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
    outputPath: z.string().optional(),
  }),

  create_directory: z.object({ path: z.string().min(1) }),

  list_directory: z.object({
    path: z.string().min(1),
    depth: z.number().int().nonnegative().optional().default(2),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().positive().max(1000).optional().default(200),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  move_file: z.object({
    source: z.string().min(1),
    destination: z.string().min(1),
  }),

  get_file_info: z.object({ path: z.string().min(1) }),

  edit_block: z.object({
    file_path: z.string().min(1),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  start_search: z.object({
    path: z.string().min(1),
    pattern: z.string().min(1),
    searchType: z.enum(["files", "content"]).optional().default("files"),
    filePattern: z.string().optional(),
    ignoreCase: z.boolean().optional().default(true),
    maxResults: z.number().int().positive().optional(),
    includeHidden: z.boolean().optional().default(false),
    literalSearch: z.boolean().optional().default(false),
    origin: z.enum(["ui", "llm"]).optional(),
  }),

  get_more_search_results: z.object({
    sessionId: z.string().min(1),
    offset: z.number().int().nonnegative().optional().default(0),
    length: z.number().int().positive().optional().default(100),
  }),

  stop_search: z.object({ sessionId: z.string().min(1) }),

  list_searches: z.object({}),

  get_usage_stats: z.object({}),

  get_recent_tool_calls: z.object({
    maxResults: z.number().int().min(1).max(1000).optional().default(50),
    toolName: z.string().optional(),
    since: z.string().datetime().optional(),
  }),
} as const;

export type OperationName = keyof typeof toolSchemas;
