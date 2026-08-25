const REDACTED = "[REDACTED]";

const CREDENTIAL_FLAG =
  /(^|\s)(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|authorization))(?:\s+|=)([^\s]+)/gi;
const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION))\s*=\s*([^\s]+)/gi;
const BEARER = /\b(Bearer)\s+([^\s]+)/gi;
const KNOWN_LITERAL_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function redactArgvSecrets(command: string): string {
  return command
    .replace(CREDENTIAL_FLAG, (_match, prefix: string, flag: string) => `${prefix}${flag} ${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KNOWN_LITERAL_SECRET, REDACTED);
}

export function assertNoCredentialArgv(command: string): void {
  if (redactArgvSecrets(command) !== command) {
    throw new Error(
      "MCP command must not pass API keys, tokens, passwords, or authorization secrets in argv; use environment or file-based secret injection instead",
    );
  }
}
