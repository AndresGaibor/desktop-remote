export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { input?: string }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface AutomationOptions {
  platform: string;
  maxWindows?: number;
}

export interface ActiveWindow {
  app: string;
  title: string;
}

export interface WindowListResult {
  windows: ActiveWindow[];
  truncated: boolean;
}

export interface ClipboardGetResult {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface ClipboardSetResult {
  set: boolean;
  bytes: number;
}

export interface ScreenshotResult {
  path: string;
  format: string;
  captured: boolean;
}

const MACOS_ONLY_ERROR = /macOS.*only|unsupported/i;
const PERMISSION_ERROR = /Accessibility.*Privacy.*Security|Not authorised|permission/i;

export class MacAutomation {
  private readonly runner: CommandRunner;
  private readonly platform: string;
  private readonly maxWindows: number;

  constructor(runner: CommandRunner, options: AutomationOptions) {
    this.runner = runner;
    this.platform = options.platform;
    this.maxWindows = options.maxWindows ?? 100;
  }

  private async runOsascript(script: string): Promise<string> {
    if (this.platform !== "darwin") {
      throw new Error(`macOS-only operation attempted on ${this.platform}`);
    }
    const { exitCode, stdout, stderr } = await this.runner(
      "osascript",
      ["-e", script],
      {}
    );
    if (exitCode !== 0) {
      const msg = stderr || stdout;
      if (PERMISSION_ERROR.test(msg)) {
        throw new Error(
          "Accessibility permission required. Enable in System Settings > Privacy & Security > Accessibility."
        );
      }
      throw new Error(`osascript failed: ${msg}`);
    }
    return stdout;
  }

  async getActiveWindow(): Promise<ActiveWindow> {
    const script = `tell application "System Events" to get name of first process whose frontmost is true`;
    const stdout = await this.runOsascript(script);
    const parts = stdout.trim().split("\t");
    const app = parts[0] ?? "";
    const title = parts.slice(1).join("\t");
    return { app, title };
  }

  async listWindows(): Promise<WindowListResult> {
    const script = `tell application "System Events"
      set windowList to {}
      repeat with p in (get processes whose frontmost is true)
        try
          set appName to name of p
          set winNames to name of windows of p
          repeat with w in winNames
            set end of windowList to appName & "\\t" & w
          end repeat
        end try
      end repeat
      set astid to AppleScript's text item delimiters
      set AppleScript's text item delimiters to "\\n"
      set resultText to windowList as text
      set AppleScript's text item delimiters to astid
      return resultText
    end tell`;
    const stdout = await this.runOsascript(script);
    const lines = stdout.trim().split("\n").filter(Boolean);
    const windows: ActiveWindow[] = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      if (i >= this.maxWindows) {
        truncated = true;
        break;
      }
      const line = lines[i];
      if (!line) continue;
      const parts = line.split("\t");
      windows.push({ app: parts[0] ?? "", title: parts.slice(1).join("\t") });
    }
    return { windows, truncated };
  }

  async clipboardGet(): Promise<ClipboardGetResult> {
    if (this.platform !== "darwin") {
      throw new Error(`macOS-only operation attempted on ${this.platform}`);
    }
    const { exitCode, stdout, stderr } = await this.runner("pbpaste", []);
    if (exitCode !== 0) {
      throw new Error(`pbpaste failed: ${stderr || stdout}`);
    }
    const text = stdout;
    const bytes = new TextEncoder().encode(text).length;
    const truncated = bytes > 1_000_000;
    return { text: truncated ? text.slice(0, 1_000_000) : text, bytes, truncated };
  }

  async clipboardSet(text: string): Promise<ClipboardSetResult> {
    if (this.platform !== "darwin") {
      throw new Error(`macOS-only operation attempted on ${this.platform}`);
    }
    const { exitCode, stderr } = await this.runner("pbcopy", [], { input: text });
    if (exitCode !== 0) {
      throw new Error(`pbcopy failed: ${stderr}`);
    }
    const bytes = new TextEncoder().encode(text).length;
    return { set: true, bytes };
  }

  async screenshot(options: { path: string }): Promise<ScreenshotResult> {
    if (this.platform !== "darwin") {
      throw new Error(`macOS-only operation attempted on ${this.platform}`);
    }
    const { exitCode, stderr: captureStderr } = await this.runner(
      "screencapture",
      [options.path],
      {}
    );
    if (exitCode !== 0) {
      throw new Error(`screencapture failed: ${captureStderr}`);
    }
    return { path: options.path, format: "png", captured: true };
  }

  async openApp(bundleId: string): Promise<void> {
    const script = `tell application "id:${bundleId}" to activate`;
    await this.runOsascript(script);
  }

  async focusWindow(bundleId: string): Promise<void> {
    const script = `tell application "id:${bundleId}" to activate`;
    await this.runOsascript(script);
  }

  async typeText(text: string): Promise<void> {
    const script = `tell application "System Events"
      keystroke "${text.replace(/"/g, "\\\"")}"
    end tell`;
    await this.runOsascript(script);
  }

  async keyPress(key: string): Promise<void> {
    const script = `tell application "System Events"
      keystroke ${key}
    end tell`;
    await this.runOsascript(script);
  }

  async click(x: number, y: number): Promise<void> {
    const script = `tell application "System Events"
      set mousePoint to {${x}, ${y}}
      click at mousePoint
    end tell`;
    await this.runOsascript(script);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    const script = `tell application "System Events"
      set mousePoint to {${x}, ${y}}
      double click at mousePoint
    end tell`;
    await this.runOsascript(script);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const script = `tell application "System Events"
      set mousePoint to {${x}, ${y}}
      scroll mousePoint by {${deltaX}, ${deltaY}}
    end tell`;
    await this.runOsascript(script);
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const script = `tell application "System Events"
      set startPoint to {${x1}, ${y1}}
      set endPoint to {${x2}, ${y2}}
      drag from startPoint to endPoint
    end tell`;
    await this.runOsascript(script);
  }
}
