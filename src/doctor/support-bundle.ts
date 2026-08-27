import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatDoctorReportJson, type DoctorReport } from "./doctor";
import { redactText, redactValue } from "../logging/redactor";

export const SUPPORT_BUNDLE_LOG_MAX_BYTES = 32 * 1024;
export const SUPPORT_BUNDLE_JSON_MAX_BYTES = 64 * 1024;

const ALLOWED_LOG_NAMES = new Set([
  "daemon.log",
  "daemon.log.1",
  "daemon.log.2",
  "mcp.log",
  "tunnel.stdout.log",
  "tunnel.stderr.log",
]);
const PAYLOAD_KEYS = new Set(["arguments", "input", "result", "payload", "content", "body"]);

export interface SupportBundleLogFile {
  name: string;
  content: string;
}

export interface CreateSupportBundleOptions {
  report: DoctorReport;
  outputPath?: string;
  logFiles?: SupportBundleLogFile[];
  now?: () => Date;
}

export interface SupportBundleResult {
  path: string;
  files: string[];
}

export async function createSupportBundle(options: CreateSupportBundleOptions): Promise<SupportBundleResult> {
  const now = options.now ?? (() => new Date());
  const outputPath = options.outputPath ?? join(process.cwd(), `desktop-remote-support-${safeTimestamp(now())}`);
  await mkdir(outputPath, { recursive: true, mode: 0o700 });
  await chmod(outputPath, 0o700);

  await writeBoundedJson(join(outputPath, "doctor.json"), options.report, true);
  await writeBoundedJson(join(outputPath, "build.json"), options.report.build, false);
  await writeBoundedJson(join(outputPath, "tunnel.json"), options.report.tunnel, false);

  const written = new Set(["doctor.json", "build.json", "tunnel.json"]);
  for (const file of options.logFiles ?? []) {
    if (!ALLOWED_LOG_NAMES.has(file.name)) continue;
    const content = boundLog(file.content);
    await writePrivateFile(join(outputPath, file.name), content);
    written.add(file.name);
  }

  return { path: outputPath, files: [...written].sort() };
}

async function writeBoundedJson(path: string, value: unknown, doctor: boolean): Promise<void> {
  const serialized = doctor ? formatDoctorReportJson(redactValue(value) as DoctorReport) : stringifyJson(redactValue(value));
  const bounded = Buffer.byteLength(serialized) <= SUPPORT_BUNDLE_JSON_MAX_BYTES
    ? serialized
    : stringifyJson({ truncated: true, kind: doctor ? "doctor" : "diagnostics" });
  await writePrivateFile(path, `${bounded}\n`);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function boundLog(content: string): string {
  const redacted = content.split(/\r?\n/).map((line) => redactLogLine(line)).join("\n");
  if (Buffer.byteLength(redacted) <= SUPPORT_BUNDLE_LOG_MAX_BYTES) return redacted;
  return truncateUtf8(redacted, SUPPORT_BUNDLE_LOG_MAX_BYTES);
}

function redactLogLine(line: string): string {
  if (!line) return line;
  try {
    return JSON.stringify(stripPayloads(redactValue(JSON.parse(line))));
  } catch {
    return redactText(line);
  }
}

function stripPayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPayloads);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      PAYLOAD_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) ? "[OMITTED]" : stripPayloads(nested),
    ]),
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "\n[TRUNCATED]\n";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(value.length - middle) + suffix) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(value.length - low) + suffix;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested, 2) ?? "null";
}

function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}
