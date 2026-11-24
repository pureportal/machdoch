import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";
import {
  findTerminalFileLinks,
  type TerminalFileLink,
} from "./workspace-terminal-links";
import {
  adjacentCommandLine,
  parseFinalTermSequence,
  parseVsCodeShellSequence,
  parseWorkingDirectoryUrl,
  type ShellIntegrationEvent,
} from "./workspace-terminal-shell-integration";

const MAX_TRACKED_COMMANDS = 500;
const MAX_COMMAND_OUTPUT_LINES = 2_000;

interface TrackedCommand {
  prompt: IMarker;
  output: IMarker | null;
  end: IMarker | null;
  command: string | null;
  exitCode: number | null;
}

export interface TerminalFeatureCallbacks {
  onCwd: (path: string) => void;
  onCommandFinished: (command: string | null, exitCode: number | null) => void;
  openUrl: (url: string) => void;
  openFileLink: (link: TerminalFileLink, cwd: string | null) => void;
}

export class TerminalFeatures {
  readonly search = new SearchAddon();
  private readonly serializer = new SerializeAddon();
  private readonly disposables: IDisposable[] = [];
  private readonly commands: TrackedCommand[] = [];
  private current: TrackedCommand | null = null;
  private renderer: WebglAddon | null = null;
  private cwdPath: string | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly callbacks: TerminalFeatureCallbacks,
  ) {
    terminal.loadAddon(this.search);
    terminal.loadAddon(this.serializer);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((_, uri) => callbacks.openUrl(uri)));
    this.disposables.push(
      terminal.parser.registerOscHandler(633, (data) =>
        this.handle(parseVsCodeShellSequence(data)),
      ),
      terminal.parser.registerOscHandler(133, (data) =>
        this.handle(parseFinalTermSequence(data)),
      ),
      terminal.parser.registerOscHandler(7, (data) =>
        this.handle(parseWorkingDirectoryUrl(data)),
      ),
      terminal.registerLinkProvider({
        provideLinks: (lineNumber, callback) => {
          const text = terminal.buffer.active
            .getLine(lineNumber - 1)
            ?.translateToString(true);
          const links = text ? findTerminalFileLinks(text) : [];
          callback(
            links.length === 0
              ? undefined
              : links.map((link) => ({
                  range: {
                    start: { x: link.start + 1, y: lineNumber },
                    end: { x: link.end, y: lineNumber },
                  },
                  text: text?.slice(link.start, link.end) ?? link.path,
                  activate: () => callbacks.openFileLink(link, this.cwdPath),
                })),
          );
        },
      }),
    );
  }

  get cwd(): string | null {
    return this.cwdPath;
  }

  get hasCommands(): boolean {
    return this.commands.length > 0;
  }

  attachRenderer(): void {
    if (this.renderer) return;
    try {
      const renderer = new WebglAddon();
      renderer.onContextLoss(() => {
        renderer.dispose();
        if (this.renderer === renderer) this.renderer = null;
      });
      this.terminal.loadAddon(renderer);
      this.renderer = renderer;
    } catch (failure) {
      console.warn("WebGL terminal rendering is unavailable", failure);
    }
  }

  private handle(event: ShellIntegrationEvent | null): boolean {
    if (!event) return false;
    switch (event.kind) {
      case "prompt-start":
        this.startCommand();
        break;
      case "command-line":
        if (this.current) this.current.command = event.command.trim() || null;
        break;
      case "command-executed":
        if (this.current)
          this.current.output = this.terminal.registerMarker(0) ?? null;
        break;
      case "command-finished":
        this.finishCommand(event.exitCode);
        break;
      case "cwd":
        if (event.path !== this.cwdPath) {
          this.cwdPath = event.path;
          this.callbacks.onCwd(event.path);
        }
        break;
      case "prompt-end":
        break;
    }
    return true;
  }

  private startCommand(): void {
    if (this.current && !this.current.output) {
      this.current.prompt.dispose();
      this.commands.pop();
    }
    const prompt = this.terminal.registerMarker(0);
    if (!prompt) return;
    this.current = {
      prompt,
      output: null,
      end: null,
      command: null,
      exitCode: null,
    };
    this.commands.push(this.current);
    while (this.commands.length > MAX_TRACKED_COMMANDS) {
      const removed = this.commands.shift();
      removed?.prompt.dispose();
      removed?.output?.dispose();
      removed?.end?.dispose();
    }
  }

  private finishCommand(exitCode: number | null): void {
    const command = this.current;
    if (!command || !command.output) return;
    command.end = this.terminal.registerMarker(0) ?? null;
    command.exitCode = exitCode;
    this.terminal.registerDecoration({
      marker: command.prompt,
      overviewRulerOptions: {
        color: exitCode === null || exitCode === 0 ? "#64748b" : "#f87171",
        position: "left",
      },
    });
    this.current = null;
    this.callbacks.onCommandFinished(command.command, exitCode);
  }

  private finishedCommands(): TrackedCommand[] {
    return this.commands.filter(
      (command) =>
        command.output &&
        !command.prompt.isDisposed &&
        command !== this.current,
    );
  }

  lastCommand(): string | null {
    const commands = this.finishedCommands().filter(
      (command) => command.command,
    );
    return commands.at(-1)?.command ?? null;
  }

  lastCommandOutput(): string | null {
    const command = this.finishedCommands().at(-1);
    if (!command?.output || command.output.isDisposed) return null;
    const buffer = this.terminal.buffer.active;
    const end =
      command.end && !command.end.isDisposed ? command.end.line : buffer.length;
    const start = Math.max(command.output.line, end - MAX_COMMAND_OUTPUT_LINES);
    const lines: string[] = [];
    for (let line = start; line < end; line += 1) {
      const bufferLine = buffer.getLine(line);
      if (!bufferLine) continue;
      const text = bufferLine.translateToString(true);
      if (bufferLine.isWrapped && lines.length > 0)
        lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const output = lines.join("\n").trim();
    return output ? output : null;
  }

  jump(direction: "previous" | "next"): void {
    const records = this.commands
      .filter((command) => !command.prompt.isDisposed)
      .map((command) => ({ promptLine: command.prompt.line }));
    const target = adjacentCommandLine(
      records,
      this.terminal.buffer.active.viewportY,
      direction,
    );
    if (target !== null) this.terminal.scrollToLine(target);
  }

  serialize(scrollback: number): string {
    return this.serializer.serialize({
      scrollback,
      excludeAltBuffer: true,
      excludeModes: true,
    });
  }

  resetCommands(): void {
    for (const command of this.commands.splice(0)) {
      command.prompt.dispose();
      command.output?.dispose();
      command.end?.dispose();
    }
    this.current = null;
  }

  dispose(): void {
    this.resetCommands();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }
}
