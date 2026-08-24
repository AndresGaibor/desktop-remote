import { listOperations } from "../core/operations";

export interface McpToolDefinition {
  name: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
}

export function createToolDefinitions(): readonly McpToolDefinition[] {
  return listOperations().map((operation) => ({
    name: operation.name,
    description: `Desktop Remote ${operation.category} operation: ${operation.name}.`,
    annotations: {
      readOnlyHint: !operation.destructive,
      destructiveHint: operation.destructive,
    },
  }));
}
