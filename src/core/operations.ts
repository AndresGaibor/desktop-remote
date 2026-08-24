export type OperationCategory = "filesystem" | "search" | "process" | "operation";

export interface OperationDefinition {
  name: string;
  category: OperationCategory;
  destructive: boolean;
}

const OPERATIONS: readonly OperationDefinition[] = [
  operation("read_file", "filesystem"),
  operation("read_multiple_files", "filesystem"),
  operation("write_file", "filesystem", true),
  operation("create_directory", "filesystem", true),
  operation("list_directory", "filesystem"),
  operation("move_file", "filesystem", true),
  operation("get_file_info", "filesystem"),
  operation("edit_block", "filesystem", true),
  operation("write_pdf", "filesystem", true),
  operation("start_search", "search"),
  operation("get_more_search_results", "search"),
  operation("stop_search", "search", true),
  operation("list_searches", "search"),
  operation("start_process", "process", true),
  operation("read_process_output", "process"),
  operation("interact_with_process", "process", true),
  operation("force_terminate", "process", true),
  operation("list_sessions", "process"),
  operation("list_processes", "process"),
  operation("kill_process", "process", true),
  operation("get_config", "operation"),
  operation("set_config_value", "operation", true),
  operation("get_usage_stats", "operation"),
  operation("get_recent_tool_calls", "operation"),
];

export function listOperations(): readonly OperationDefinition[] {
  return OPERATIONS.map((operation) => ({ ...operation }));
}

export function getOperation(name: string): OperationDefinition | undefined {
  const operation = OPERATIONS.find((candidate) => candidate.name === name);
  return operation ? { ...operation } : undefined;
}

function operation(name: string, category: OperationCategory, destructive = false): OperationDefinition {
  return { name, category, destructive };
}
