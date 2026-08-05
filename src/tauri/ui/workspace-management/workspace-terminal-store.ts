import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IDisposable } from "@xterm/xterm";
import {
  acknowledgeWorkspaceTerminalOutput,
  discoverWorkspaceShells,
  resizeWorkspaceTerminal,
  startWorkspaceTerminal,
  stopWorkspaceTerminal,
  stopWorkspaceTerminals,
  writeWorkspaceTerminal,
  writeWorkspaceTerminalBinary,
  type WorkspaceShell,
  type WorkspaceShellDiscovery,
  type WorkspaceTerminalEvent,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

export type WorkspaceTerminalStatus =
  | "loading"
  | "starting"
  | "running"
  | "exited"
  | "error";

export interface WorkspaceTerminalSessionView {
  id: string;
  label: string;
  title: string | null;
  shellId: string;
  shellLabel: string;
  status: WorkspaceTerminalStatus;
  error: string | null;
  sessionActive: boolean;
  transitioning: boolean;
}

export interface WorkspaceTerminalStoreSnapshot {
  discovery: WorkspaceShellDiscovery | null;
  discoveryError: string | null;
  terminals: readonly WorkspaceTerminalSessionView[];
  activeTerminalId: string | null;
}

const terminalTheme = {
  background: "#050910",
  foreground: "#cbd5e1",
  cursor: "#7dd3fc",
  cursorAccent: "#050910",
  selectionBackground: "#0c4a6e99",
  black: "#0f172a",
  red: "#f87171",
  green: "#86efac",
  yellow: "#fde68a",
  blue: "#7dd3fc",
  magenta: "#c4b5fd",
  cyan: "#67e8f9",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#bbf7d0",
  brightYellow: "#fef3c7",
  brightBlue: "#bae6fd",
  brightMagenta: "#ddd6fe",
  brightCyan: "#a5f3fc",
  brightWhite: "#f8fafc",
} as const;

const decodeTerminalOutput = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

let fallbackTerminalId = 0;

const createTerminalId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  fallbackTerminalId += 1;
  return `workspace-terminal-${fallbackTerminalId}`;
};

const errorMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

class WorkspaceTerminalSession {
  readonly id = createTerminalId();
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly shell: WorkspaceShell;
  readonly ordinal: number;
  private readonly workspaceRoot: string;
  private readonly onChange: () => void;
  private readonly disposables: IDisposable[] = [];
  private backendSessionId: string | null = null;
  private generation = 0;
  private resizeTimer: number | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private transitionPending = false;
  private terminalTitle = "";
  status: WorkspaceTerminalStatus = "starting";
  error: string | null = null;

  constructor(
    workspaceRoot: string,
    shell: WorkspaceShell,
    ordinal: number,
    onChange: () => void,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.shell = shell;
    this.ordinal = ordinal;
    this.onChange = onChange;
    this.terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      drawBoldTextInBrightColors: true,
      fontFamily:
        '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      screenReaderMode: true,
      scrollback: 5000,
      theme: terminalTheme,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) {
        return true;
      }
      if (event.key.toLowerCase() === "c" && this.terminal.hasSelection()) {
        void navigator.clipboard?.writeText(this.terminal.getSelection());
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        void navigator.clipboard
          ?.readText()
          .then((text) => this.terminal.paste(text))
          .catch(() => {});
        return false;
      }
      return true;
    });
    this.disposables.push(
      this.terminal.onData((data) => this.queueInput(data, false)),
      this.terminal.onBinary((data) => this.queueInput(data, true)),
      this.terminal.onResize(({ cols, rows }) => this.queueResize(cols, rows)),
      this.terminal.onTitleChange((title) => {
        this.terminalTitle = title.trim().slice(0, 160);
        this.onChange();
      }),
    );
  }

  get view(): WorkspaceTerminalSessionView {
    return {
      id: this.id,
      label: `${this.shell.label} ${this.ordinal}`,
      title: this.terminalTitle || null,
      shellId: this.shell.id,
      shellLabel: this.shell.label,
      status: this.status,
      error: this.error,
      sessionActive: this.backendSessionId !== null,
      transitioning: this.transitionPending,
    };
  }

  mount(container: HTMLDivElement): void {
    if (this.disposed) return;
    if (!this.terminal.element) {
      this.terminal.open(container);
    } else if (this.terminal.element.parentElement !== container) {
      container.append(this.terminal.element);
    }
  }

  fit(focus: boolean): void {
    if (this.disposed || !this.terminal.element?.isConnected) return;
    try {
      this.fitAddon.fit();
      if (focus) this.terminal.focus();
    } catch {
      // A later ResizeObserver callback retries once layout is measurable.
    }
  }

  clear(): void {
    this.terminal.clear();
  }

  dismissError(): void {
    if (this.error === null) return;
    this.error = null;
    this.onChange();
  }

  private setError(failure: unknown): void {
    if (this.disposed) return;
    this.error = errorMessage(failure);
    this.status = "error";
    this.onChange();
  }

  private queueInput(data: string, binary: boolean): void {
    const sessionId = this.backendSessionId;
    const generation = this.generation;
    if (!sessionId || this.disposed) return;
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (
          this.backendSessionId !== sessionId ||
          this.generation !== generation ||
          this.disposed
        ) {
          return;
        }
        if (binary) {
          await writeWorkspaceTerminalBinary(sessionId, data);
        } else {
          await writeWorkspaceTerminal(sessionId, data);
        }
      })
      .catch((failure: unknown) => {
        if (
          this.backendSessionId === sessionId &&
          this.generation === generation
        ) {
          this.setError(failure);
        }
      });
  }

  private queueResize(columns: number, rows: number): void {
    const sessionId = this.backendSessionId;
    if (!sessionId || this.disposed) return;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    const generation = this.generation;
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (
        this.backendSessionId !== sessionId ||
        this.generation !== generation ||
        this.disposed
      ) {
        return;
      }
      void resizeWorkspaceTerminal(sessionId, columns, rows).catch(
        (failure: unknown) => {
          if (
            this.backendSessionId === sessionId &&
            this.generation === generation
          ) {
            this.setError(failure);
          }
        },
      );
    }, 80);
  }

  start(): Promise<void> {
    if (this.disposed || this.transitionPending) return Promise.resolve();
    const operation = this.startInternal();
    this.startPromise = operation;
    void operation.then(
      () => {
        if (this.startPromise === operation) this.startPromise = null;
      },
      () => {
        if (this.startPromise === operation) this.startPromise = null;
      },
    );
    return operation;
  }

  private async startInternal(): Promise<void> {
    this.transitionPending = true;
    const generation = ++this.generation;
    const previousSessionId = this.backendSessionId;
    this.backendSessionId = null;
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.error = null;
    this.status = "starting";
    this.terminal.reset();
    this.onChange();

    if (previousSessionId) {
      try {
        await stopWorkspaceTerminal(previousSessionId);
      } catch (failure) {
        if (!this.disposed && this.generation === generation) {
          this.transitionPending = false;
          this.setError(failure);
        }
        return;
      }
    }
    if (this.disposed || this.generation !== generation) return;

    let exitedBeforeStartResolved = false;
    let failedBeforeStartResolved = false;
    const handleEvent = (event: WorkspaceTerminalEvent): void => {
      if (this.disposed || this.generation !== generation) return;
      switch (event.type) {
        case "output":
          const output = decodeTerminalOutput(event.data);
          try {
            this.terminal.write(output, () => {
              void acknowledgeWorkspaceTerminalOutput(
                event.sessionId,
                output.byteLength,
              ).catch((failure: unknown) => {
                if (
                  this.backendSessionId === event.sessionId &&
                  this.generation === generation
                ) {
                  this.setError(failure);
                }
              });
            });
          } catch (failure) {
            void acknowledgeWorkspaceTerminalOutput(
              event.sessionId,
              output.byteLength,
            );
            failedBeforeStartResolved = true;
            this.setError(failure);
          }
          break;
        case "error":
          failedBeforeStartResolved = true;
          this.error = event.message;
          this.status = "error";
          this.onChange();
          break;
        case "exit":
          exitedBeforeStartResolved = true;
          this.backendSessionId = null;
          this.status = "exited";
          this.terminal.write(
            `\r\n\x1b[90m[Process exited${
              event.exitCode === null ? "" : ` with code ${event.exitCode}`
            }]\x1b[0m\r\n`,
          );
          this.onChange();
          break;
      }
    };

    try {
      const started = await startWorkspaceTerminal(
        this.workspaceRoot,
        this.shell.id,
        Math.max(2, this.terminal.cols),
        Math.max(1, this.terminal.rows),
        handleEvent,
      );
      if (this.disposed || this.generation !== generation) {
        await stopWorkspaceTerminal(started.sessionId).catch(() => {});
        return;
      }
      if (!exitedBeforeStartResolved) {
        this.backendSessionId = started.sessionId;
        this.status = failedBeforeStartResolved ? "error" : "running";
        this.onChange();
        await resizeWorkspaceTerminal(
          started.sessionId,
          Math.max(2, this.terminal.cols),
          Math.max(1, this.terminal.rows),
        ).catch(() => {});
      }
    } catch (failure) {
      if (!this.disposed && this.generation === generation) {
        this.setError(failure);
      }
    } finally {
      if (!this.disposed && this.generation === generation) {
        this.transitionPending = false;
        this.onChange();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.generation += 1;
    this.transitionPending = false;
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    const sessionId = this.backendSessionId;
    this.backendSessionId = null;
    this.status = "exited";
    this.onChange();
    if (!sessionId) return;
    try {
      await stopWorkspaceTerminal(sessionId);
    } catch (failure) {
      this.setError(failure);
    }
  }

  async dispose(stopBackend: boolean): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    const sessionId = this.backendSessionId;
    const startPromise = this.startPromise;
    this.backendSessionId = null;
    for (const disposable of this.disposables) disposable.dispose();
    this.terminal.dispose();
    const cleanup = [startPromise];
    if (stopBackend && sessionId) {
      cleanup.push(stopWorkspaceTerminal(sessionId));
    }
    const results = await Promise.allSettled(
      cleanup.filter((operation): operation is Promise<void> => !!operation),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }
}

export class WorkspaceTerminalStore {
  readonly workspaceRoot: string;
  private readonly terminals: WorkspaceTerminalSession[] = [];
  private readonly listeners = new Set<() => void>();
  private discovery: WorkspaceShellDiscovery | null = null;
  private discoveryError: string | null = null;
  private activeTerminalId: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private nextOrdinal = 1;
  private disposed = false;
  private snapshot: WorkspaceTerminalStoreSnapshot;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.snapshot = this.createSnapshot();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkspaceTerminalStoreSnapshot => this.snapshot;

  private createSnapshot(): WorkspaceTerminalStoreSnapshot {
    return {
      discovery: this.discovery,
      discoveryError: this.discoveryError,
      terminals: this.terminals.map((terminal) => terminal.view),
      activeTerminalId: this.activeTerminalId,
    };
  }

  private publish = (): void => {
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  };

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = discoverWorkspaceShells()
      .then(async (discovery) => {
        if (this.disposed) return;
        this.discovery = discovery;
        this.publish();
        const shellId = discovery.defaultShellId ?? discovery.shells[0]?.id;
        if (shellId && this.terminals.length === 0) {
          await this.createTerminal(shellId);
        }
      })
      .catch((failure: unknown) => {
        if (this.disposed) return;
        this.discoveryError = errorMessage(failure);
        this.publish();
      });
    return this.initializePromise;
  }

  async createTerminal(shellId: string): Promise<void> {
    if (this.disposed) return;
    if (!this.discovery) await this.initialize();
    const shell = this.discovery?.shells.find(
      (candidate) => candidate.id === shellId,
    );
    if (!shell || this.disposed) return;
    const terminal = new WorkspaceTerminalSession(
      this.workspaceRoot,
      shell,
      this.nextOrdinal,
      this.publish,
    );
    this.nextOrdinal += 1;
    this.terminals.push(terminal);
    this.activeTerminalId = terminal.id;
    this.publish();
    await terminal.start();
  }

  selectTerminal(terminalId: string): void {
    if (
      terminalId === this.activeTerminalId ||
      !this.terminals.some((terminal) => terminal.id === terminalId)
    ) {
      return;
    }
    this.activeTerminalId = terminalId;
    this.publish();
  }

  mountTerminal(terminalId: string, container: HTMLDivElement): void {
    this.terminals
      .find((terminal) => terminal.id === terminalId)
      ?.mount(container);
  }

  fitActiveTerminal(focus = false): void {
    this.terminals
      .find((terminal) => terminal.id === this.activeTerminalId)
      ?.fit(focus);
  }

  clearActiveTerminal(): void {
    this.terminals
      .find((terminal) => terminal.id === this.activeTerminalId)
      ?.clear();
  }

  dismissActiveError(): void {
    const terminal = this.terminals.find(
      (terminal) => terminal.id === this.activeTerminalId,
    );
    if (terminal?.view.error) {
      terminal.dismissError();
      return;
    }
    if (this.discoveryError !== null) {
      this.discoveryError = null;
      this.publish();
    }
  }

  reportError(failure: unknown): void {
    this.discoveryError = errorMessage(failure);
    this.publish();
  }

  async startActiveTerminal(): Promise<void> {
    await this.terminals
      .find((terminal) => terminal.id === this.activeTerminalId)
      ?.start();
  }

  async stopActiveTerminal(): Promise<void> {
    await this.terminals
      .find((terminal) => terminal.id === this.activeTerminalId)
      ?.stop();
  }

  async closeTerminal(terminalId: string): Promise<void> {
    const index = this.terminals.findIndex(
      (terminal) => terminal.id === terminalId,
    );
    if (index < 0) return;
    const [terminal] = this.terminals.splice(index, 1);
    if (this.activeTerminalId === terminalId) {
      this.activeTerminalId =
        this.terminals[Math.min(index, this.terminals.length - 1)]?.id ?? null;
    }
    this.publish();
    try {
      await terminal?.dispose(true);
    } catch (failure) {
      this.reportError(failure);
    }
  }

  async disposeAfterWorkspaceRemoval(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const terminals = this.terminals.splice(0);
    this.activeTerminalId = null;
    this.publish();
    const results = await Promise.allSettled(
      terminals.map((terminal) => terminal.dispose(true)),
    );
    this.listeners.clear();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}

const workspaceTerminalStores = new Map<string, WorkspaceTerminalStore>();

export const getWorkspaceTerminalStore = (
  workspaceRoot: string,
): WorkspaceTerminalStore => {
  const key = createWorkspaceRootKey(workspaceRoot);
  const existing = workspaceTerminalStores.get(key);
  if (existing) return existing;
  const store = new WorkspaceTerminalStore(workspaceRoot);
  workspaceTerminalStores.set(key, store);
  return store;
};

export const disposeWorkspaceTerminals = async (
  workspaceRoot: string,
): Promise<void> => {
  const key = createWorkspaceRootKey(workspaceRoot);
  const store = workspaceTerminalStores.get(key);
  workspaceTerminalStores.delete(key);
  let localFailure: unknown;
  try {
    await store?.disposeAfterWorkspaceRemoval();
  } catch (failure) {
    localFailure = failure;
  }
  let backendFailure: unknown;
  try {
    await stopWorkspaceTerminals(workspaceRoot);
  } catch (failure) {
    backendFailure = failure;
  }
  if (localFailure || backendFailure) {
    throw backendFailure ?? localFailure;
  }
};
