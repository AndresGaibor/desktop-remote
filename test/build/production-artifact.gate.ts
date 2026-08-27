import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildProduction } from "../../scripts/build-production";

const repoRoot = join(import.meta.dir, "../..");

describe("production artifact regression gate", () => {
  test("runs CLI help, isolated doctor, and MCP initialize/list-tools from the compiled artifact", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "dr-production-artifact-"));
    const isolatedDirectories = ["home", "config", "cache", "state", "runtime", "tmp"];
    await Promise.all(isolatedDirectories.map((directory) => mkdir(join(isolatedRoot, directory), { mode: 0o700 })));
    const env = createIsolatedEnvironment(isolatedRoot);

    try {
      const outputDir = join(isolatedRoot, "build");
      const layout = await buildProduction({
        rootDir: repoRoot,
        outDir: outputDir,
        bunPath: process.execPath,
      });
      const artifact = join(outputDir, layout.cli);

      const help = await runArtifact(artifact, ["--help"], env);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: desktop-remote");
      expect(help.stderr).toBe("");

      const status = await runArtifact(artifact, ["status"], env);
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toBe("");
      expect(JSON.parse(status.stdout)).toMatchObject({ loaded: expect.any(Boolean), enabled: expect.any(Boolean) });

      const doctor = await runArtifact(artifact, ["doctor", "--json"], env);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stderr).toBe("");
      expect(JSON.parse(doctor.stdout)).toMatchObject({ config: { valid: true } });

      const transport = new StdioClientTransport({
        command: artifact,
        args: ["mcp"],
        cwd: repoRoot,
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "desktop-remote-production-artifact-gate", version: "1.0.0" });

      try {
        await client.connect(transport, { timeout: 5_000 });
        expect(client.getInstructions()).toContain("local computer");

        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.find((tool) => tool.name === "read_file")).toBeDefined();
        expect(tools.find((tool) => tool.name === "get_config")).toMatchObject({
          name: "get_config",
          outputSchema: expect.any(Object),
        });
      } finally {
        await client.close();
      }
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

function createIsolatedEnvironment(root: string): Record<string, string> {
  return {
    HOME: join(root, "home"),
    PATH: process.env.PATH ?? "",
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
  };
}

async function runArtifact(
  artifact: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([artifact, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
