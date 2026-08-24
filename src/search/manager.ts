import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

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
};

type NormalizedSearchOptions = Omit<SearchOptions, "path" | "searchType" | "root" | "mode"> & {
  path: string;
  searchType: "files" | "content";
};

type SearchStatus = "running" | "completed" | "stopped";

type SearchJob = {
  id: string;
  status: SearchStatus;
  results: string[];
  task: Promise<void>;
};

export class SearchManager {
  private readonly searches = new Map<string, SearchJob>();

  async start(options: SearchOptions): Promise<{ id: string; sessionId: string; status: "running" | "completed" }> {
    const path = options.path ?? options.root;
    const searchType = options.searchType ?? options.mode;
    if (!path || !options.pattern) {
      throw new Error("path and pattern are required");
    }
    if (searchType !== "files" && searchType !== "content") {
      throw new Error("Unsupported search mode");
    }
    const normalizedOptions: NormalizedSearchOptions = { ...options, path, searchType };

    const id = crypto.randomUUID();
    const job: SearchJob = {
      id,
      status: "running",
      results: [],
      task: Promise.resolve(),
    };
    job.task = this.run(job, normalizedOptions);
    this.searches.set(id, job);
    return { id, sessionId: id, status: "running" };
  }

  async getMore(
    id: string,
    offset: number,
    length: number,
  ): Promise<{ id: string; sessionId: string; results: string[]; total: number; done: boolean }> {
    const job = this.searches.get(id);
    if (!job) {
      throw new Error("Search not found");
    }
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
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
    return [...this.searches.values()].map(({ id, status }) => ({ id, status }));
  }

  private async run(job: SearchJob, options: NormalizedSearchOptions): Promise<void> {
    const maxResults = options.maxResults === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxResults));
    const files = await this.collectFiles(options.path, options.includeHidden ?? false);
    const pattern = createSearchPattern(options.pattern, options);
    const filePattern = options.filePattern === undefined
      ? undefined
      : createGlobPattern(options.filePattern, options.ignoreCase ?? true);

    for (const file of files) {
      if (job.status === "stopped" || job.results.length >= maxResults) {
        break;
      }
      if (filePattern !== undefined && !filePattern.test(relative(options.path, file).split(sep).join("/"))) {
        continue;
      }
      if (options.searchType === "files") {
        if (pattern.test(basename(file))) {
          job.results.push(file);
        }
        continue;
      }

      try {
        if (pattern.test(await readFile(file, "utf8"))) {
          job.results.push(file);
        }
      } catch {
        // Los archivos que no pueden leerse no forman parte de la búsqueda.
      }
    }

    if (job.status === "running") {
      job.status = "completed";
    }
  }

  private async collectFiles(directory: string, includeHidden: boolean): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.collectFiles(path, includeHidden));
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
    throw new Error("pattern must be a valid regular expression unless literalSearch is enabled");
  }
}

function createGlobPattern(pattern: string, ignoreCase: boolean): RegExp {
  const source = [...pattern].map((character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return escapeRegExp(character);
  }).join("");
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
