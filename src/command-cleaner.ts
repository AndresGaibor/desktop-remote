import chalk from "chalk";

export type CommandStep =
  | { type: "exec"; cmd: string }
  | { type: "write_file"; filePath: string; fileContent: string }
  | { type: "script_exec"; interpreter: string; language: string; code: string }
  | { type: "cd"; path: string };

export function parseShellCommand(rawCommand: string): CommandStep[] {
  const steps: CommandStep[] = [];
  let rem = rawCommand;

  // 1. Check for interpreter heredocs: e.g. python3 - <<'PY' ... PY
  const scriptHeredocMatch = extractScriptHeredoc(rem);
  if (scriptHeredocMatch) {
    if (scriptHeredocMatch.before) {
      steps.push(...parseSimpleChain(scriptHeredocMatch.before));
    }
    steps.push({
      type: "script_exec",
      interpreter: scriptHeredocMatch.interpreter,
      language: scriptHeredocMatch.language,
      code: scriptHeredocMatch.code,
    });
    if (scriptHeredocMatch.after) {
      steps.push(...parseShellCommand(scriptHeredocMatch.after));
    }
    return steps;
  }

  // 2. Check for cat > file <<'EOF' heredocs
  const fileHeredocMatch = extractFileHeredoc(rem);
  if (fileHeredocMatch) {
    if (fileHeredocMatch.before) {
      steps.push(...parseSimpleChain(fileHeredocMatch.before));
    }
    steps.push({
      type: "write_file",
      filePath: fileHeredocMatch.filePath,
      fileContent: fileHeredocMatch.content,
    });
    if (fileHeredocMatch.after) {
      steps.push(...parseShellCommand(fileHeredocMatch.after));
    }
    return steps;
  }

  return parseSimpleChain(rawCommand);
}

function extractScriptHeredoc(str: string): { before: string; interpreter: string; language: string; code: string; after: string } | null {
  const regex = /(.*?)(python3?|node|bash|zsh|ruby|perl)\s*(?:-\s*)?<<['"]?([A-Z0-9_-]+)['"]?\n([\s\S]*?)\n\3(?:\s*&&|\s*;|\s*\n|$)/m;
  const match = str.match(regex);
  if (!match) return null;

  const before = match[1]?.trim() ?? "";
  const interpreter = match[2];
  const marker = match[3];
  const code = match[4];
  if (!interpreter || !marker || code === undefined) return null;
  const afterIndex = match.index! + match[0].length;
  const after = str.slice(afterIndex).trim();

  let language = "bash";
  if (interpreter.startsWith("python")) language = "python";
  else if (interpreter === "node") language = "javascript";

  return { before, interpreter, language, code, after };
}

function extractFileHeredoc(str: string): { before: string; filePath: string; content: string; after: string } | null {
  const heredocRegex = /(.*?)(?:cat\s*>\s*['"]?([^\s"'>]+)['"]?\s*<<['"]?EOF['"]?|cat\s*<<['"]?EOF['"]?\s*>\s*['"]?([^\s"'>]+)['"]?)\n([\s\S]*?)\nEOF(?:\s*&&|\s*;|\s*\n|$)/m;
  const match = str.match(heredocRegex);
  if (!match) return null;

  const before = match[1]?.trim() ?? "";
  const filePath = match[2] || match[3];
  const content = match[4];
  if (!filePath || content === undefined) return null;
  const afterIndex = match.index! + match[0].length;
  const after = str.slice(afterIndex).trim();

  return { before, filePath, content, after };
}

function parseSimpleChain(str: string): CommandStep[] {
  const steps: CommandStep[] = [];
  const parts = str.split(/(?:&&|\n)/).map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.startsWith("cd ")) {
      steps.push({ type: "cd", path: part.slice(3).trim() });
    } else {
      steps.push({ type: "exec", cmd: part });
    }
  }
  return steps;
}
