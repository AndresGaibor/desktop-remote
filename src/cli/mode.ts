export type CliMode =
  | { kind: "pipe" }
  | { kind: "replay"; file: string }
  | { kind: "interactive"; desktopCommanderArgs: string[] };

export interface SelectCliModeInput {
  stdinIsTTY: boolean;
  args: string[];
}

export function selectCliMode(input: SelectCliModeInput): CliMode {
  const [first, second] = input.args;
  if (first === "replay") {
    if (!second) throw new Error("replay requires a JSONL file path");
    return { kind: "replay", file: second };
  }

  if (!input.stdinIsTTY) return { kind: "pipe" };

  return {
    kind: "interactive",
    desktopCommanderArgs: input.args.length > 0
      ? [...input.args]
      : ["remote", "--persist-session"],
  };
}
