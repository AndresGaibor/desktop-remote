import { expect, test } from "bun:test";

test("piped stdin preserves formatted compatibility output", async () => {
  const child = Bun.spawn([process.execPath, "run", "bin/cli.ts"], {
    cwd: import.meta.dir + "/..",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  child.stdin.write(
    "🔧 Received tool call 4c16033f-0cfd-429a-90b5-8ec079793aa9: list_sessions {} metadata: {}\n" +
      "✅ Tool call list_sessions completed:\n" +
      " {\"content\":[{\"type\":\"text\",\"text\":\"No active sessions\"}]}\n",
  );
  child.stdin.end();

  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("TOOL CALL  list_sessions");
  expect(stdout).toContain("COMPLETED  list_sessions");
  expect(stdout).toContain("No active sessions");
});
