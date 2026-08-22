export type CliMode =
  | { kind: "pipe" }
  | { kind: "replay"; file: string }
  | { kind: "daemon"; desktopCommanderArgs: string[] }
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

  if (first === "daemon") {
    const rest = input.args.slice(1);
    return {
      kind: "daemon",
      desktopCommanderArgs: rest.length > 0
        ? rest
        : ["remote", "--persist-session"],
    };
  }

  if (!input.stdinIsTTY) return { kind: "pipe" };

  return {
    kind: "interactive",
    desktopCommanderArgs: input.args.length > 0
      ? [...input.args]
      : ["remote", "--persist-session"],
  };
}
