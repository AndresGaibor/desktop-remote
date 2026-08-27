import { PROTOCOL_VERSION } from "../ipc/protocol";
import { computeMcpToolCatalogHash, createToolDefinitions } from "../mcp/tools";

export const RUNTIME_CONTRACT_MISMATCH_CODE = "RUNTIME_VERSION_MISMATCH" as const;
export const RUNTIME_CONTRACT_MISMATCH_MESSAGE =
  "RUNTIME_VERSION_MISMATCH: MCP and daemon were built from different runtime contracts.";

export interface RuntimeContractIdentity {
  buildId: string;
  operationContractHash: string;
  protocolVersion: number;
}

const MCP_BUILD_ID = "mcp-a";

let cachedIdentity: RuntimeContractIdentity | undefined;

export function getRuntimeContractIdentity(): RuntimeContractIdentity {
  if (cachedIdentity) return cachedIdentity;
  const tools = createToolDefinitions();
  cachedIdentity = {
    buildId: MCP_BUILD_ID,
    operationContractHash: computeMcpToolCatalogHash(tools),
    protocolVersion: PROTOCOL_VERSION,
  };
  return cachedIdentity;
}

export function assertRuntimeContract(daemonIdentity: RuntimeContractIdentity): void {
  const mcpIdentity = getRuntimeContractIdentity();
  const hasIdentity = daemonIdentity.buildId !== undefined &&
    daemonIdentity.operationContractHash !== undefined &&
    daemonIdentity.protocolVersion !== undefined;
  if (!hasIdentity) return;
  if (
    daemonIdentity.buildId !== mcpIdentity.buildId ||
    daemonIdentity.operationContractHash !== mcpIdentity.operationContractHash ||
    daemonIdentity.protocolVersion !== mcpIdentity.protocolVersion
  ) {
    throw new Error(RUNTIME_CONTRACT_MISMATCH_MESSAGE);
  }
}
