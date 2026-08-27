export const OPERATION_CLASSES = ["light", "heavy", "process", "document"] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

export interface OperationScheduleOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface OperationSchedulerOptions {
  concurrency?: Partial<Record<OperationClass, number>>;
  maxQueueSize?: number;
  maxQueueSizeByClass?: Partial<Record<OperationClass, number>>;
  now?: () => number;
}

export interface OperationSchedulerSnapshot {
  active: Record<OperationClass, number>;
  queued: Record<OperationClass, number>;
  totalActive: number;
  totalQueued: number;
}

export class OperationSchedulerBusyError extends Error {
  readonly code = "OPERATION_SCHEDULER_BUSY" as const;
  override readonly name = "OperationSchedulerBusyError";

  constructor(
    public readonly operationClass: OperationClass,
    public readonly limit: "global" | "class",
  ) {
    super(limit === "global"
      ? "Operation scheduler queue is saturated: global queue limit reached"
      : `Operation scheduler queue is saturated: ${operationClass} queue limit reached`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export { OperationSchedulerBusyError as OperationSchedulerSaturatedError };

export class OperationSchedulerCancelledError extends Error {
  readonly code = "OPERATION_SCHEDULER_CANCELLED" as const;
  override readonly name = "OperationSchedulerCancelledError";

  constructor() {
    super("Operation scheduler operation was cancelled before it started");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OperationDeadlineExceededError extends Error {
  readonly code = "OPERATION_DEADLINE_EXCEEDED" as const;
  override readonly name = "OperationDeadlineExceededError";

  constructor() {
    super("Operation scheduler deadline expired before the operation started");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type OperationTask = () => unknown | PromiseLike<unknown>;

interface QueuedOperation {
  operationClass: OperationClass;
  task: OperationTask;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  deadlineAt?: number;
  started: boolean;
}

const DEFAULT_CONCURRENCY: Record<OperationClass, number> = {
  light: 8,
  heavy: 2,
  process: 2,
  document: 1,
};

const DEFAULT_MAX_QUEUE_SIZE = 64;
const DEFAULT_MAX_QUEUE_SIZE_BY_CLASS: Record<OperationClass, number> = {
  light: 32,
  heavy: 16,
  process: 16,
  document: 16,
};

export class OperationScheduler {
  private readonly concurrency: Record<OperationClass, number>;
  private readonly maxQueueSize: number;
  private readonly maxQueueSizeByClass: Record<OperationClass, number>;
  private readonly now: () => number;
  private readonly active: Record<OperationClass, number> = createCounts();
  private readonly queues: Record<OperationClass, QueuedOperation[]> = createQueues();
  private totalQueued = 0;

  constructor(options: OperationSchedulerOptions = {}) {
    this.concurrency = createLimits(DEFAULT_CONCURRENCY, options.concurrency, "concurrency", false);
    this.maxQueueSize = validateLimit(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, "maxQueueSize", true);
    this.maxQueueSizeByClass = createLimits(
      DEFAULT_MAX_QUEUE_SIZE_BY_CLASS,
      options.maxQueueSizeByClass,
      "maxQueueSizeByClass",
      true,
    );
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    operationClass: OperationClass,
    task: () => T | PromiseLike<T>,
    options: OperationScheduleOptions = {},
  ): Promise<T> {
    assertOperationClass(operationClass);
    assertScheduleOptions(options);

    if (options.signal?.aborted) throw new OperationSchedulerCancelledError();
    if (isPastDeadline(options.deadlineAt, this.now())) throw new OperationDeadlineExceededError();

    if (this.active[operationClass] < this.concurrency[operationClass]) {
      return this.startImmediately(operationClass, task);
    }

    if (this.totalQueued >= this.maxQueueSize) {
      throw new OperationSchedulerBusyError(operationClass, "global");
    }
    if (this.queues[operationClass].length >= this.maxQueueSizeByClass[operationClass]) {
      throw new OperationSchedulerBusyError(operationClass, "class");
    }

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedOperation = {
        operationClass,
        task: () => task(),
        resolve: (value) => resolve(value as T),
        reject,
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        started: false,
      };
      this.queues[operationClass].push(queued);
      this.totalQueued += 1;
      this.installCancellation(queued, options.deadlineAt);
    });
  }

  snapshot(): OperationSchedulerSnapshot {
    const active = { ...this.active };
    const queued = {
      light: this.queues.light.length,
      heavy: this.queues.heavy.length,
      process: this.queues.process.length,
      document: this.queues.document.length,
    } satisfies Record<OperationClass, number>;
    return {
      active,
      queued,
      totalActive: sumCounts(active),
      totalQueued: this.totalQueued,
    };
  }

  private startImmediately<T>(
    operationClass: OperationClass,
    task: () => T | PromiseLike<T>,
  ): Promise<T> {
    this.active[operationClass] += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.active[operationClass] -= 1;
        this.drain(operationClass);
      });
  }

  private installCancellation(queued: QueuedOperation, deadlineAt: number | undefined): void {
    const cancel = (error: Error) => {
      if (!this.removeQueued(queued)) return;
      queued.reject(error);
    };

    if (queued.signal) {
      queued.onAbort = () => cancel(new OperationSchedulerCancelledError());
      queued.signal.addEventListener("abort", queued.onAbort, { once: true });
    }

    if (deadlineAt !== undefined) {
      const delay = Math.max(0, deadlineAt - this.now());
      queued.deadlineTimer = setTimeout(() => cancel(new OperationDeadlineExceededError()), delay);
    }
  }

  private removeQueued(queued: QueuedOperation): boolean {
    if (queued.started) return false;
    const queue = this.queues[queued.operationClass];
    const index = queue.indexOf(queued);
    if (index < 0) return false;

    queue.splice(index, 1);
    this.totalQueued -= 1;
    this.cleanupQueued(queued);
    return true;
  }

  private drain(operationClass: OperationClass): void {
    const queue = this.queues[operationClass];
    while (this.active[operationClass] < this.concurrency[operationClass] && queue.length > 0) {
      const queued = queue.shift()!;
      this.totalQueued -= 1;
      if (queued.signal?.aborted) {
        this.cleanupQueued(queued);
        queued.reject(new OperationSchedulerCancelledError());
        continue;
      }
      if (isPastDeadline(queued.deadlineAt, this.now())) {
        this.cleanupQueued(queued);
        queued.reject(new OperationDeadlineExceededError());
        continue;
      }
      queued.started = true;
      this.cleanupQueued(queued);
      this.active[operationClass] += 1;

      void Promise.resolve()
        .then(queued.task)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active[operationClass] -= 1;
          this.drain(operationClass);
        });
    }
  }

  private cleanupQueued(queued: QueuedOperation): void {
    if (queued.deadlineTimer !== undefined) {
      clearTimeout(queued.deadlineTimer);
      queued.deadlineTimer = undefined;
    }
    if (queued.onAbort !== undefined) {
      queued.signal?.removeEventListener("abort", queued.onAbort);
      queued.onAbort = undefined;
    }
  }
}

export function classifyOperation(
  name: string,
  input: Record<string, unknown> = {},
): OperationClass {
  if (PROCESS_OPERATIONS.has(name)) return "process";
  if (SEARCH_OPERATIONS.has(name)) return "heavy";
  if (DOCUMENT_OPERATIONS.has(name) || hasDocumentPath(name, input)) return "document";
  return "light";
}

const SEARCH_OPERATIONS = new Set([
  "start_search",
  "get_more_search_results",
  "stop_search",
  "list_searches",
]);

const PROCESS_OPERATIONS = new Set([
  "start_process",
  "read_process_output",
  "interact_with_process",
  "force_terminate",
  "list_sessions",
  "list_processes",
  "kill_process",
]);

const DOCUMENT_OPERATIONS = new Set(["write_pdf"]);

function hasDocumentPath(name: string, input: Record<string, unknown>): boolean {
  if (name === "read_multiple_files") {
    return Array.isArray(input.paths) && input.paths.some(isDocumentPath);
  }
  if (name !== "read_file" && name !== "write_file" && name !== "edit_block") return false;
  return isDocumentPath(input.path) || isDocumentPath(input.file_path) || isDocumentPath(input.outputPath);
}

function isDocumentPath(value: unknown): boolean {
  return typeof value === "string" && /\.(docx?|pdf|xlsx?|xlsm)$/i.test(value);
}

function createCounts(): Record<OperationClass, number> {
  return { light: 0, heavy: 0, process: 0, document: 0 };
}

function createQueues(): Record<OperationClass, QueuedOperation[]> {
  return { light: [], heavy: [], process: [], document: [] };
}

function createLimits(
  defaults: Record<OperationClass, number>,
  overrides: Partial<Record<OperationClass, number>> | undefined,
  label: string,
  allowZero: boolean,
): Record<OperationClass, number> {
  return {
    light: validateLimit(overrides?.light ?? defaults.light, `${label}.light`, allowZero),
    heavy: validateLimit(overrides?.heavy ?? defaults.heavy, `${label}.heavy`, allowZero),
    process: validateLimit(overrides?.process ?? defaults.process, `${label}.process`, allowZero),
    document: validateLimit(overrides?.document ?? defaults.document, `${label}.document`, allowZero),
  };
}

function validateLimit(value: number, label: string, allowZero: boolean): number {
  const valid = Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return value;
}

function assertOperationClass(value: string): asserts value is OperationClass {
  if (!OPERATION_CLASSES.includes(value as OperationClass)) {
    throw new Error(`Unknown operation class: ${value}`);
  }
}

function assertScheduleOptions(options: OperationScheduleOptions): void {
  if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) {
    throw new Error("deadlineAt must be a finite timestamp");
  }
}

function isPastDeadline(deadlineAt: number | undefined, now: number): boolean {
  return deadlineAt !== undefined && deadlineAt <= now;
}

function sumCounts(counts: Record<OperationClass, number>): number {
  return counts.light + counts.heavy + counts.process + counts.document;
}
