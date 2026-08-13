import { expect, test } from "bun:test";
import { LogFormatter } from "../src/formatter";
import { LogParser } from "../src/parser";

const SAMPLE_LOG = `[DEBUG] Verbose mode:  false
☕ No sleep mode enabled
🚀 Starting MCP Device...
 - 🔌 Connected to Desktop Commander MCP

✅ Device ready:
   - User:         androymartin99@gmail.com
   - Device ID:    f0fed73a-328b-45c7-b2b3-be4e8f8c1d47
   - Device Name:  Andress-MacBook-Air-2.local

🔧 Received tool call 82f7a468-1234-5678-90ab-cdef12345678: start_process {"shell":"bash","command":"python3 - <<'PY'\nimport json\nprint(json.dumps({'url':'https://www.agenthansa.com/dashboard','title':'AgentHansa','text':'AGENTHANSA\\nExplore\\nArena\\nLIVE\\n⚽ World Cup'}))\nPY"} metadata: {}
✅ Tool call start_process completed:
 {"content":[{"type":"text","text":"{\\n  \\\"url\\\": \\\"https://www.agenthansa.com/dashboard\\\",\\n  \\\"title\\\": \\\"AgentHansa: Building a New World for Agents\\\",\\n  \\\"text\\\": \\\"AGENTHANSA\\\\nExplore\\\\nArena\\\\nLIVE\\\\n⚽ World Cup\\\\nCommunity\\\\nOur Story\\\\nSearch\\\\nDashboard\\\"\\n}"}]}
`;

test("formats web snapshot JSON gracefully", () => {
  const formatter = new LogFormatter();
  const parser = new LogParser(formatter);

  const lines = SAMPLE_LOG.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const res = parser.parseLine(line);
    if (res !== null) {
      output.push(res.formattedText);
    }
  }
  const flushed = parser.flush();
  if (flushed !== null) output.push(flushed.formattedText);

  const resultStr = output.join("\n");
  expect(resultStr).toContain("WEB PAGE / TEXT SNAPSHOT");
  expect(resultStr).toContain("https://www.agenthansa.com/dashboard");
});

test("formats OpenAPI json preceded by profile warning line", () => {
  const formatter = new LogFormatter();
  const parser = new LogParser(formatter);

  const sampleWithNoise = `🔧 Received tool call f9f5cec7: start_process {"shell":"bash","command":"curl http://127.0.0.1/openapi.json"}
✅ Tool call start_process completed:
 {"content":[{"type":"text","text":"/Users/andresgaibor/.profile: line 1: /Users/andresgaibor/.deno/env: No such file or directory\\n{\\\"source\\\":\\\"/openapi.json\\\",\\\"paths\\\":[\\\"/api/companies/{company_id}/withdraw\\\",\\\"/api/agents/rewards-status\\\",\\\"/api/agents/me/reddit-karma-quest/submit\\\"]}"}]}
`;

  const lines = sampleWithNoise.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const res = parser.parseLine(line);
    if (res !== null) output.push(res.formattedText);
  }
  const flushed = parser.flush();
  if (flushed !== null) output.push(flushed.formattedText);

  const res = output.join("\n");
  expect(res).toContain("📦 JSON Response:");
  expect(res).toContain("/api/companies/{company_id}/withdraw");
});
