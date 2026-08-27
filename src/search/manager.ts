import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export type ContentSearchMatch = {
  path: string;
  line: number;
  column: number;
  match: string;
  before: string[];
  after: string[];
};

export type SearchResult = string | ContentSearchMatch;

export type SearchOptions = {
  path?: string;
  pattern: string;
  searchType?: "files" | "content";
  filePattern?: string;
  ignoreCase?: boolean;
  includeHidden?: boolean;
  contextLines?: number;
  maxResults?: number;
  timeout_ms?: number;
  earlyTermination?: boolean;
  literalSearch?: boolean;
  /** Compatibilidad interna con consumidores anteriores al contrato MCP. */
  root?: string;
  mode?: "files" | "content";
  timeoutMs?: number;
  onResult?: (file: string) => void;
};

export type SearchManagerOptions = {
  sessionTtlMs?: number;
  /** Alias corto para consumidores internos antiguos. */
  ttlMs?: number;
};

type NormalizedSearchOptions = {
  path: string;
  pattern: string;
  searchType: "files" | "content";
  filePattern?: string;
  ignoreCase: boolean;
  includeHidden: boolean;
  contextLines: number;
  maxResults?: number;
  timeoutMs: number;
  earlyTermination: boolean;
  literalSearch: boolean;
  onResult?: (file: string) => void;
};

type SearchStatus = "running" | "completed" | "stopped";

type SearchJob = {
  id: string;
  status: SearchStatus;
  results: SearchResult[];
  task: Promise<void>;
  truncated: boolean;
  startTime: number;
};

type PendingMatch = Omit<ContentSearchMatch, "path" | "after"> & {
  after: string[];
};

const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1_000;

export class SearchManager {
  private readonly searches = new Map<string, SearchJob>();
  private readonly sessionTtlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: SearchManagerOptions = {}) {
    const ttl = options.sessionTtlMs ?? options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.sessionTtlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_SESSION_TTL_MS;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), Math.min(this.sessionTtlMs, 60_000));
    (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
  }

  async start(
    options: SearchOptions,
  ): Promise<{
    id: string;
    sessionId: string;
    status: "running" | "completed";
  }> {
    this.cleanupExpired();
    const path = options.path ?? options.root;
    const searchType = options.searchType ?? options.mode;
    if (!path || !options.pattern) {
      throw new Error("path and pattern are required");
    }
    if (searchType !== "files" && searchType !== "content") {
      throw new Error("Unsupported search mode");
    }

    const timeoutMs = options.timeout_ms ?? options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const normalizedOptions: NormalizedSearchOptions = {
      path,
      pattern: options.pattern,
      searchType,
      filePattern: options.filePattern,
      ignoreCase: options.ignoreCase ?? true,
      includeHidden: options.includeHidden ?? false,
      contextLines: normalizeNonNegative(options.contextLines ?? 5),
      maxResults: options.maxResults === undefined
        ? undefined
        : normalizeNonNegative(options.maxResults),
      timeoutMs: normalizeNonNegative(timeoutMs),
      earlyTermination: options.earlyTermination ?? false,
      literalSearch: options.literalSearch ?? false,
      onResult: options.onResult,
    };

    // Valida los patrones antes de exponer una sesión cuyo trabajo podría fallar después.
    createSearchPattern(normalizedOptions.pattern, normalizedOptions);
    if (normalizedOptions.filePattern !== undefined) {
      createGlobPattern(normalizedOptions.filePattern, normalizedOptions.ignoreCase);
    }

    const id = crypto.randomUUID();
    const job: SearchJob = {
      id,
      status: "running",
      results: [],
      task: Promise.resolve(),
      truncated: false,
      startTime: Date.now(),
    };
    this.searches.set(id, job);
    job.task = this.run(job, normalizedOptions).catch(() => {
      job.truncated = true;
      if (job.status === "running") job.status = "completed";
    });
    return { id, sessionId: id, status: "running" };
  }

  async getMore(
    id: string,
    offset: number,
    length: number,
  ): Promise<{
    id: string;
    sessionId: string;
    results: SearchResult[];
    total: number;
    done: boolean;
    truncated?: boolean;
  }> {
    this.cleanupExpired();
    const job = this.searches.get(id);
    if (!job) {
      throw new Error("Search not found");
    }
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length < 0
    ) {
      throw new Error("offset and length must be non-negative integers");
    }

    // No espera job.task: el consumidor recibe la página descubierta hasta ahora.
    const results = job.results.slice(offset, offset + length);
    return {
      id,
      sessionId: id,
      results,
      total: job.results.length,
      done: job.status !== "running" && offset + results.length >= job.results.length,
      truncated: job.truncated || undefined,
    };
  }

  async stop(id: string): Promise<void> {
    this.cleanupExpired();
    const job = this.searches.get(id);
    if (!job) {
      throw new Error("Search not found");
    }
    job.status = "stopped";
    await job.task;
  }

  list(): Array<{ id: string; status: string }> {
    this.cleanupExpired();
    return [...this.searches.values()].map(({ id, status }) => ({
      id,
      status,
    }));
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, job] of this.searches) {
      if (now - job.startTime < this.sessionTtlMs) continue;
      if (job.status === "running") job.status = "stopped";
      this.searches.delete(id);
    }
  }

  private async run(
    job: SearchJob,
    options: NormalizedSearchOptions,
  ): Promise<void> {
    const maxResults = options.maxResults === undefined
      ? Number.POSITIVE_INFINITY
      : options.maxResults;
    if (maxResults === 0) {
      job.truncated = true;
      job.status = "completed";
      return;
    }

    const pattern = createSearchPattern(options.pattern, options);
    const filePattern = options.filePattern === undefined
      ? undefined
      : createGlobPattern(options.filePattern, options.ignoreCase);

    for await (const file of this.walkFiles(options.path, options.includeHidden)) {
      if (job.status !== "running") break;
      if (this.timedOut(job, options.timeoutMs)) break;
      if (
        filePattern !== undefined &&
        !filePattern.test(relative(options.path, file).split(sep).join("/"))
      ) {
        continue;
      }

      if (options.searchType === "files") {
        if (pattern.test(basename(file))) {
          this.addResult(job, file, maxResults, options);
        }
      } else {
        await this.matchFileContent(file, pattern, job, options, maxResults);
      }

      if (job.status !== "running" || job.truncated || (options.earlyTermination && job.results.length > 0)) {
        break;
      }
    }

    if (job.status === "running") job.status = "completed";
  }

  private addResult(
    job: SearchJob,
    result: SearchResult,
    maxResults: number,
    options: NormalizedSearchOptions,
  ): boolean {
    if (job.results.length >= maxResults) {
      job.truncated = true;
      return false;
    }
    job.results.push(result);
    if (typeof result === "string") options.onResult?.(result);
    else options.onResult?.(result.path);
    if (job.results.length >= maxResults && maxResults !== Number.POSITIVE_INFINITY) {
      job.truncated = true;
    }
    return true;
  }

  private timedOut(job: SearchJob, timeoutMs: number): boolean {
    if (Date.now() - job.startTime < timeoutMs) return false;
    job.truncated = true;
    return true;
  }

  private async matchFileContent(
    file: string,
    pattern: RegExp,
    job: SearchJob,
    options: NormalizedSearchOptions,
    maxResults: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let lineNumber = 0;
      let before: string[] = [];
      const pending: PendingMatch[] = [];
      const stream = createReadStream(file, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const emitReady = (force: boolean, currentLine: number) => {
        while (pending.length > 0) {
          const match = pending[0];
          if (match === undefined) return;
          if (!force && currentLine < match.line + options.contextLines) return;
          pending.shift();
          const emitted = this.addResult(job, { ...match, path: file }, maxResults, options);
          if (!emitted || options.earlyTermination) {
            job.truncated ||= !emitted;
            rl.close();
            stream.destroy();
            return;
          }
        }
      };

      const stopIfNeeded = (): boolean => {
        if (job.status !== "running") {
          rl.close();
          stream.destroy();
          return true;
        }
        if (this.timedOut(job, options.timeoutMs)) {
          rl.close();
          stream.destroy();
          return true;
        }
        return false;
      };

      rl.on("line", (line) => {
        if (settled || stopIfNeeded()) return;
        lineNumber += 1;

        for (const match of pending) {
          if (lineNumber > match.line && lineNumber <= match.line + options.contextLines) {
            match.after.push(line);
          }
        }
        emitReady(false, lineNumber);
        if (settled || job.status !== "running") return;

        const matches = findLineMatches(line, pattern);
        const matchesToAdd = options.earlyTermination ? matches.slice(0, 1) : matches;
        for (const match of matchesToAdd) {
          pending.push({
            line: lineNumber,
            column: match.column,
            match: match.match,
            before: [...before],
            after: [],
          });
        }
        emitReady(false, lineNumber);
        before = [...before, line].slice(-options.contextLines);
        if (options.earlyTermination && job.results.length > 0) {
          rl.close();
          stream.destroy();
        }
      });
      rl.on("close", () => {
        emitReady(true, lineNumber);
        finish();
      });
      rl.on("error", finish);
      stream.on("error", finish);
    });
  }

  private async *walkFiles(
    directory: string,
    includeHidden: boolean,
  ): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkFiles(path, includeHidden);
      } else if (entry.isFile()) {
        yield path;
      }
    }
  }
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function createSearchPattern(pattern: string, options: Pick<SearchOptions, "ignoreCase" | "literalSearch">): RegExp {
  const source = options.literalSearch ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, options.ignoreCase === false ? "" : "i");
  } catch {
    throw new Error(
      "pattern must be a valid regular expression unless literalSearch is enabled",
    );
  }
}

function findLineMatches(line: string, pattern: RegExp): Array<{ match: string; column: number }> {
  const flags = `${pattern.flags.replace(/[gy]/g, "")}g`;
  const matcher = new RegExp(pattern.source, flags);
  const matches: Array<{ match: string; column: number }> = [];
  let found: RegExpExecArray | null;
  while ((found = matcher.exec(line)) !== null) {
    matches.push({ match: found[0], column: found.index + 1 });
    if (found[0] === "") matcher.lastIndex += 1;
  }
  return matches;
}

function createGlobPattern(pattern: string, ignoreCase: boolean): RegExp {
  const source = [...pattern]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return escapeRegExp(character);
    })
    .join("");
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
