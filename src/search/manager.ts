import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SearchOptions = {
  root: string;
  pattern: string;
  mode: "files" | "content";
  maxResults?: number;
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

  async start(options: SearchOptions): Promise<{ id: string; status: "running" | "completed" }> {
    if (!options.root || !options.pattern) {
      throw new Error("root and pattern are required");
    }
    if (options.mode !== "files" && options.mode !== "content") {
      throw new Error("Unsupported search mode");
    }

    const id = crypto.randomUUID();
    const job: SearchJob = {
      id,
      status: "running",
      results: [],
      task: Promise.resolve(),
    };
    job.task = this.run(job, options);
    this.searches.set(id, job);
    return { id, status: "running" };
  }

  async getMore(
    id: string,
    offset: number,
    length: number,
  ): Promise<{ id: string; results: string[]; total: number; done: boolean }> {
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

  private async run(job: SearchJob, options: SearchOptions): Promise<void> {
    const maxResults = options.maxResults === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxResults));
    const files = await this.collectFiles(options.root);

    for (const file of files) {
      if (job.status === "stopped" || job.results.length >= maxResults) {
        break;
      }
      if (options.mode === "files") {
        if (file.includes(options.pattern)) {
          job.results.push(file);
        }
        continue;
      }

      try {
        if ((await readFile(file, "utf8")).includes(options.pattern)) {
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

  private async collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.collectFiles(path));
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
    return files.sort();
  }
}
