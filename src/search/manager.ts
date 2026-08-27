import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export type SearchOptions = {
  path?: string;
  pattern: string;
  searchType?: "files" | "content";
  filePattern?: string;
  ignoreCase?: boolean;
  includeHidden?: boolean;
  maxResults?: number;
  literalSearch?: boolean;
  /** Compatibilidad interna con consumidores anteriores al contrato MCP. */
  root?: string;
  mode?: "files" | "content";
  timeoutMs?: number;
  onResult?: (file: string) => void;
};

type NormalizedSearchOptions = Omit<
  SearchOptions,
  "path" | "searchType" | "root" | "mode"
> & {
  path: string;
  searchType: "files" | "content";
  timeoutMs: number;
  onResult?: (file: string) => void;
};

type SearchStatus = "running" | "completed" | "stopped";

type SearchJob = {
  id: string;
  status: SearchStatus;
  results: string[];
  task: Promise<void>;
  truncated: boolean;
  startTime: number;
};

export class SearchManager {
  private readonly searches = new Map<string, SearchJob>();

  async start(
    options: SearchOptions,
  ): Promise<{
    id: string;
    sessionId: string;
    status: "running" | "completed";
  }> {
    const path = options.path ?? options.root;
    const searchType = options.searchType ?? options.mode;
    if (!path || !options.pattern) {
      throw new Error("path and pattern are required");
    }
    if (searchType !== "files" && searchType !== "content") {
      throw new Error("Unsupported search mode");
    }
    const normalizedOptions: NormalizedSearchOptions = {
      ...options,
      path,
      searchType,
      timeoutMs: options.timeoutMs ?? 10_000,
    };

    const id = crypto.randomUUID();
    const job: SearchJob = {
      id,
      status: "running",
      results: [],
      task: Promise.resolve(),
      truncated: false,
      startTime: Date.now(),
    };
    job.task = this.run(job, normalizedOptions);
    this.searches.set(id, job);
    return { id, sessionId: id, status: "running" };
  }

  async getMore(
    id: string,
    offset: number,
    length: number,
  ): Promise<{
    id: string;
    sessionId: string;
    results: string[];
    total: number;
    done: boolean;
    truncated?: boolean;
  }> {
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

    await job.task;
    const results = job.results.slice(offset, offset + length);
    return {
      id,
      sessionId: id,
      results,
      total: job.results.length,
      done: offset + results.length >= job.results.length,
      truncated: job.truncated || undefined,
    };
  }

  async stop(id: string): Promise<void> {
    const job = this.searches.get(id);
    if (!job) {
      throw new Error("Search not found");
    }
    job.status = "stopped";
    await job.task;
  }

  list(): Array<{ id: string; status: string }> {
    return [...this.searches.values()].map(({ id, status }) => ({
      id,
      status,
    }));
  }

  private async run(
    job: SearchJob,
    options: NormalizedSearchOptions,
  ): Promise<void> {
    const maxResults =
      options.maxResults === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(options.maxResults));
    const timeoutMs =
      options.timeoutMs === undefined
        ? 10_000
        : Math.max(0, Math.floor(options.timeoutMs));
    const onResult = options.onResult;
    const files = await this.collectFiles(
      options.path,
      options.includeHidden ?? false,
    );
    const pattern = createSearchPattern(options.pattern, options);
    const filePattern =
      options.filePattern === undefined
        ? undefined
        : createGlobPattern(options.filePattern, options.ignoreCase ?? true);

    let totalFound = 0;

    for (const file of files) {
      if (job.status === "stopped") {
        break;
      }
      const elapsed = Date.now() - job.startTime;
      if (elapsed >= timeoutMs) {
        job.truncated = true;
        break;
      }
      if (
        filePattern !== undefined &&
        !filePattern.test(relative(options.path, file).split(sep).join("/"))
      ) {
        continue;
      }
      if (options.searchType === "files") {
        if (pattern.test(basename(file))) {
          totalFound++;
          if (job.results.length < maxResults) {
            const newResults = [...job.results, file];
            job.results = newResults;
            onResult?.(file);
          }
        }
        continue;
      }

      const matched = await this.matchFileContent(file, pattern);
      if (matched) {
        totalFound++;
        if (job.results.length < maxResults) {
          const newResults = [...job.results, file];
          job.results = newResults;
          onResult?.(file);
        }
      }
    }

    if (totalFound > maxResults) {
      job.truncated = true;
    }
    if (job.status === "running") {
      job.status = "completed";
    }
  }

  private async matchFileContent(
    file: string,
    pattern: RegExp,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const rl = createInterface(createReadStream(file, { encoding: "utf8" }));
      rl.on("line", (line) => {
        if (!resolved && pattern.test(line)) {
          resolved = true;
          rl.close();
          resolve(true);
        }
      });
      rl.on("close", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
      rl.on("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
    });
  }

  private async collectFiles(
    directory: string,
    includeHidden: boolean,
  ): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectFiles(path, includeHidden)));
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
    return files.sort();
  }
}

function createSearchPattern(pattern: string, options: SearchOptions): RegExp {
  const source = options.literalSearch ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, options.ignoreCase === false ? "" : "i");
  } catch {
    throw new Error(
      "pattern must be a valid regular expression unless literalSearch is enabled",
    );
  }
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
