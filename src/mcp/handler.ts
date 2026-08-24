export interface OperationExecutor {
  execute(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: true;
}

export function createOperationHandler(executor: OperationExecutor) {
  return async (name: string, input: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      const result = await executor.execute(name, input);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };
}
