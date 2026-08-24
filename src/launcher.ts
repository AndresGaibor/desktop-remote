export function getCommandToSpawn(customCmd?: string): string {
  return customCmd || "desktop-remote";
}

export function getSpawnArgs(_customCmd: string | undefined, targetArgs: string[]): string[] {
  return targetArgs;
}
