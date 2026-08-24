export interface StartedProcess {
  id: string;
  pid: number;
}

export interface ProcessOutput {
  id: string;
  status: "completed" | "failed";
  output: string;
  exitCode: number;
}

interface ManagedProcess {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: Promise<string>;
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  async start(command: string[]): Promise<StartedProcess> {
    if (command.length === 0 || !command[0]) throw new Error("command is required");
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const id = crypto.randomUUID();
    this.processes.set(id, {
      child,
      output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        .then(([stdout, stderr]) => `${stdout}${stderr}`),
    });
    return { id, pid: child.pid };
  }

  async readOutput(id: string): Promise<ProcessOutput> {
    const process = this.processes.get(id);
    if (!process) throw new Error(`Unknown process: ${id}`);
    const [exitCode, output] = await Promise.all([process.child.exited, process.output]);
    return { id, status: exitCode === 0 ? "completed" : "failed", output, exitCode };
  }
}
