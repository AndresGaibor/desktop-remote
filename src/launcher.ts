export function getCommandToSpawn(customCmd?: string): string {
  return customCmd || "desktop-commander";
}

export function getSpawnArgs(_customCmd: string | undefined, targetArgs: string[]): string[] {
  return targetArgs;
}
