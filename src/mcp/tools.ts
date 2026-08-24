import { listOperations } from "../core/operations";
import { toolSchemas } from "./schemas";
import { z } from "zod";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
}

export function createToolDefinitions(): readonly McpToolDefinition[] {
  return listOperations().map((operation) => {
    const schema = toolSchemas[operation.name as keyof typeof toolSchemas];
    return {
      name: operation.name,
      description: `Desktop Remote ${operation.category} operation: ${operation.name}.`,
      inputSchema: schema ?? z.object({}),
      annotations: {
        readOnlyHint: !operation.destructive,
        destructiveHint: operation.destructive,
      },
    };
  });
}
