import { listOperations } from "../core/operations";
import { outputSchemas } from "./output-schemas";
import { toolSchemas } from "./schemas";
import { z } from "zod";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

type ToolCopy = {
  title: string;
  description: string;
  openWorldHint?: boolean;
  destructiveHint?: boolean;
};

const TOOL_COPY: Record<string, ToolCopy> = {  read_file: { title: "Read file", description: "Use this when the user wants to inspect a local file or fetch a URL without modifying it.", openWorldHint: true },
  read_multiple_files: { title: "Read multiple files", description: "Use this when the user wants to inspect several local files together without modifying them." },
  write_file: { title: "Write file", description: "Use this when the user wants to create, replace, or append content in a local file." },
  create_directory: { title: "Create directory", description: "Use this when the user wants to create a local directory.", destructiveHint: false },
  list_directory: { title: "List directory", description: "Use this when the user wants to inspect files and folders under a local directory." },
  move_file: { title: "Move file", description: "Use this when the user wants to move or rename a local file or directory." },
  get_file_info: { title: "Get file info", description: "Use this when the user wants local filesystem metadata for a path." },
  edit_block: { title: "Edit file block", description: "Use this when the user wants a targeted replacement or range edit in a local file." },
  write_pdf: { title: "Write PDF", description: "Use this when the user wants to create a PDF file from supplied content." },
  start_search: { title: "Start search", description: "Use this when the user wants to search local filenames or file contents." },
  get_more_search_results: { title: "Get more search results", description: "Use this when a prior local search has more results to retrieve." },
  stop_search: { title: "Stop search", description: "Use this when an active local search should be cancelled.", destructiveHint: false },
  list_searches: { title: "List searches", description: "Use this when the user wants to inspect active or recent local searches." },
  start_process: { title: "Start process", description: "Use this when the user wants to run a command or start a local process. The command may access external systems.", openWorldHint: true },
  read_process_output: { title: "Read process output", description: "Use this when the user wants output from a process that was started earlier." },
  interact_with_process: { title: "Interact with process", description: "Use this when the user wants to send input to a running process. Input may affect external systems.", openWorldHint: true },
  force_terminate: { title: "Force terminate process", description: "Use this when the user explicitly wants to forcefully terminate a managed process." },
  list_sessions: { title: "List sessions", description: "Use this when the user wants to inspect managed process sessions." },
  list_processes: { title: "List processes", description: "Use this when the user wants to inspect currently running system processes." },
  kill_process: { title: "Kill process", description: "Use this when the user explicitly wants to terminate a system process." },
  get_config: { title: "Get configuration", description: "Use this when the user wants to inspect Desktop Remote configuration." },
  set_config_value: { title: "Set configuration value", description: "Use this when the user wants to change one Desktop Remote configuration value.", destructiveHint: false },
  get_usage_stats: { title: "Get usage stats", description: "Use this when the user wants Desktop Remote usage statistics." },
  get_recent_tool_calls: { title: "Get recent tool calls", description: "Use this when the user wants recent Desktop Remote tool-call history." },
};

export function createToolDefinitions(): readonly McpToolDefinition[] {
  return listOperations().map((operation) => {
    const name = operation.name as keyof typeof toolSchemas;
    const schema = toolSchemas[name];
    const copy = TOOL_COPY[operation.name] ?? {
      title: operation.name.replaceAll("_", " "),
      description: `Use this when the user wants to run the ${operation.name} Desktop Remote operation.`,
    };
    return {
      name: operation.name,
      title: copy.title,
      description: copy.description,
      inputSchema: schema ?? z.object({}),
      outputSchema: outputSchemas[operation.name as keyof typeof outputSchemas],
      annotations: {
        readOnlyHint: !operation.destructive,
        destructiveHint: copy.destructiveHint ?? operation.destructive,
        openWorldHint: copy.openWorldHint ?? false,
      },
    };
  });
}
