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
import {
  DEFAULT_TERMINAL_PROFILE_SETTINGS,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfileSettings,
} from "../lib/shell-store";
import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  resolveTerminalProfiles,
  terminalProfileSettingsEqual,
  type ResolvedTerminalProfiles,
} from "./workspace-terminal-profiles";

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
  profiles: ResolvedTerminalProfiles | null;
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

const TERMINAL_INPUT_CHUNK_BYTES = 48 * 1024;
const TERMINAL_INPUT_BUFFER_BYTES = 1024 * 1024;
const TERMINAL_INPUT_BUFFER_ENTRIES = 4096;
const TERMINAL_OUTPUT_ACK_CHUNK_BYTES = 256 * 1024;
const TERMINAL_SCROLLBACK_LINES = 10_000;

const decodeTerminalOutput = (value: string): Uint8Array => {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
};

const decodedBase64ByteLength = (value: string): number => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
};

const utf8CodePointByteLength = (codePoint: number): number =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

const splitUtf8Input = (value: string): string[] => {
  if (!value) return [];
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = utf8CodePointByteLength(codePoint);
    if (
      chunkBytes + codePointBytes > TERMINAL_INPUT_CHUNK_BYTES &&
      index > chunkStart
    ) {
      chunks.push(value.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += codePointBytes;
    index += codeUnits;
  }
  chunks.push(value.slice(chunkStart));
  return chunks;
};

interface PendingTerminalInput extends PendingStartingInput {
  sessionId: string;
}

interface PendingStartingInput {
  generation: number;
  data: string;
  binary: boolean;
  byteLength: number;
}

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
  private readonly pendingInput: PendingTerminalInput[] = [];
  private readonly pendingStartingInput: PendingStartingInput[] = [];
  private inputDrainGeneration: number | null = null;
  private bufferedInputBytes = 0;
  private bufferedInputEntries = 0;
  private readonly pendingOutputAcknowledgements = new Map<string, number>();
  private acknowledgementDrainRunning = false;
  private pendingTerminalWrites = 0;
  private readonly terminalWriteWaiters = new Set<() => void>();
  private startPromise: Promise<boolean> | null = null;
  private disposed = false;
  private transitionPending = false;
  private terminalTitle = "";
  status: WorkspaceTerminalStatus = "starting";
  error: string | null = null;

  constructor(
    workspaceRoot: string,
    shell: WorkspaceShell,
    platform: string,
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
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: terminalTheme,
      windowsPty: platform === "windows" ? { backend: "conpty" } : undefined,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const key = event.key.toLowerCase();
      const terminalClipboardShortcut =
        (event.ctrlKey && event.shiftKey) ||
        (event.metaKey && !event.ctrlKey && !event.altKey);
      if (!terminalClipboardShortcut) return true;
      if (key === "c") {
        if (this.terminal.hasSelection()) {
          void navigator.clipboard?.writeText(this.terminal.getSelection());
          return false;
        }
        return !event.metaKey;
      }
      if (key === "v") {
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

  unmount(): void {
    this.terminal.element?.remove();
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

  private completeTerminalWrite(): void {
    this.pendingTerminalWrites = Math.max(0, this.pendingTerminalWrites - 1);
    if (this.pendingTerminalWrites !== 0) return;
    for (const resolve of this.terminalWriteWaiters) resolve();
    this.terminalWriteWaiters.clear();
  }

  private writeTerminal(
    data: string | Uint8Array,
    onProcessed?: () => void,
  ): void {
    this.pendingTerminalWrites += 1;
    try {
      this.terminal.write(data, () => {
        this.completeTerminalWrite();
        onProcessed?.();
      });
    } catch (failure) {
      this.completeTerminalWrite();
      throw failure;
    }
  }

  private waitForTerminalWrites(): Promise<void> {
    if (this.pendingTerminalWrites === 0) return Promise.resolve();
    return new Promise((resolve) => this.terminalWriteWaiters.add(resolve));
  }

  private queueInput(data: string, binary: boolean): void {
    const sessionId = this.backendSessionId;
    const generation = this.generation;
    if (this.disposed || !data) return;
    if (!sessionId && !this.transitionPending) return;
    // Count in-flight writes as well as queued input; a stalled IPC write must
    // not let a large paste or repeated keystrokes grow the buffer indefinitely.
    let byteLength = data.length;
    if (!binary && byteLength <= TERMINAL_INPUT_BUFFER_BYTES) {
      byteLength = 0;
      for (const character of data) {
        byteLength += utf8CodePointByteLength(character.codePointAt(0) ?? 0);
        if (byteLength > TERMINAL_INPUT_BUFFER_BYTES) break;
      }
    }
    if (
      byteLength > TERMINAL_INPUT_BUFFER_BYTES - this.bufferedInputBytes ||
      this.bufferedInputEntries >= TERMINAL_INPUT_BUFFER_ENTRIES
    ) {
      const message =
        byteLength > TERMINAL_INPUT_BUFFER_BYTES
          ? "This terminal input exceeds 1 MB and was not sent. Paste a smaller amount."
          : "Terminal input is backed up. This input was not sent. Wait for pending input to finish, then try again.";
      if (this.error !== message) {
        this.error = message;
        this.onChange();
      }
      return;
    }
    this.bufferedInputBytes += byteLength;
    this.bufferedInputEntries += 1;
    if (!sessionId) {
      this.pendingStartingInput.push({ generation, data, binary, byteLength });
      return;
    }
    this.pendingInput.push({ sessionId, generation, data, binary, byteLength });
    this.scheduleInputDrain();
  }

  private attachBackendSession(sessionId: string, generation: number): void {
    if (
      !sessionId ||
      this.backendSessionId !== null ||
      this.generation !== generation ||
      this.disposed
    ) {
      return;
    }
    this.backendSessionId = sessionId;
    const bufferedInput = this.pendingStartingInput.splice(0);
    for (const input of bufferedInput) {
      if (input.generation === generation) {
        this.pendingInput.push({ sessionId, ...input });
      }
    }
    this.scheduleInputDrain();
    this.onChange();
  }

  private scheduleInputDrain(): void {
    if (
      this.inputDrainGeneration === this.generation ||
      this.pendingInput.length === 0
    )
      return;
    const generation = this.generation;
    this.inputDrainGeneration = generation;
    queueMicrotask(() => void this.drainInput(generation));
  }

  private clearInput(): void {
    this.pendingInput.length = 0;
    this.pendingStartingInput.length = 0;
    this.bufferedInputBytes = 0;
    this.bufferedInputEntries = 0;
  }

  private async drainInput(generation: number): Promise<void> {
    try {
      while (this.generation === generation && this.pendingInput.length > 0) {
        const first = this.pendingInput[0];
        if (!first) break;
        const values = [first.data];
        let count = 1;
        let bytes = first.byteLength;
        while (
          this.pendingInput[count]?.sessionId === first.sessionId &&
          this.pendingInput[count]?.generation === generation &&
          this.pendingInput[count]?.binary === first.binary
        ) {
          const next = this.pendingInput[count];
          if (!next || bytes + next.byteLength > TERMINAL_INPUT_CHUNK_BYTES)
            break;
          values.push(next.data);
          bytes += next.byteLength;
          count += 1;
        }
        this.pendingInput.splice(0, count);
        try {
          if (
            this.backendSessionId !== first.sessionId ||
            this.generation !== first.generation ||
            this.disposed
          ) {
            continue;
          }
          const value = values.join("");
          const chunks = first.binary
            ? Array.from(
                {
                  length: Math.ceil(value.length / TERMINAL_INPUT_CHUNK_BYTES),
                },
                (_, index) =>
                  value.slice(
                    index * TERMINAL_INPUT_CHUNK_BYTES,
                    (index + 1) * TERMINAL_INPUT_CHUNK_BYTES,
                  ),
              )
            : splitUtf8Input(value);
          for (const chunk of chunks) {
            if (
              this.backendSessionId !== first.sessionId ||
              this.generation !== first.generation ||
              this.disposed
            ) {
              break;
            }
            try {
              if (first.binary) {
                await writeWorkspaceTerminalBinary(first.sessionId, chunk);
              } else {
                await writeWorkspaceTerminal(first.sessionId, chunk);
              }
            } catch (failure) {
              if (
                this.backendSessionId === first.sessionId &&
                this.generation === first.generation
              ) {
                this.clearInput();
                this.setError(failure);
              }
              break;
            }
          }
        } finally {
          if (this.generation === generation) {
            this.bufferedInputBytes = Math.max(
              0,
              this.bufferedInputBytes - bytes,
            );
            this.bufferedInputEntries = Math.max(
              0,
              this.bufferedInputEntries - count,
            );
          }
        }
      }
    } finally {
      if (this.inputDrainGeneration === generation) {
        this.inputDrainGeneration = null;
        this.scheduleInputDrain();
      }
    }
  }

  private queueOutputAcknowledgement(sessionId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.pendingOutputAcknowledgements.set(
      sessionId,
      (this.pendingOutputAcknowledgements.get(sessionId) ?? 0) + bytes,
    );
    this.scheduleAcknowledgementDrain();
  }

  private scheduleAcknowledgementDrain(): void {
    if (
      this.acknowledgementDrainRunning ||
      this.pendingOutputAcknowledgements.size === 0
    ) {
      return;
    }
    this.acknowledgementDrainRunning = true;
    queueMicrotask(() => void this.drainOutputAcknowledgements());
  }

  private async drainOutputAcknowledgements(): Promise<void> {
    try {
      while (this.pendingOutputAcknowledgements.size > 0) {
        const next = this.pendingOutputAcknowledgements.entries().next().value;
        if (!next) break;
        const [sessionId, pendingBytes] = next;
        const bytes = Math.min(pendingBytes, TERMINAL_OUTPUT_ACK_CHUNK_BYTES);
        if (pendingBytes === bytes) {
          this.pendingOutputAcknowledgements.delete(sessionId);
        } else {
          this.pendingOutputAcknowledgements.set(
            sessionId,
            pendingBytes - bytes,
          );
        }
        try {
          await acknowledgeWorkspaceTerminalOutput(sessionId, bytes);
        } catch (failure) {
          this.pendingOutputAcknowledgements.delete(sessionId);
          if (this.backendSessionId === sessionId && !this.disposed) {
            this.setError(failure);
          }
        }
      }
    } finally {
      this.acknowledgementDrainRunning = false;
      this.scheduleAcknowledgementDrain();
    }
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

  start(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.startPromise) {
      if (this.transitionPending) return this.startPromise;
      const previousStart = this.startPromise;
      const restartGeneration = this.generation;
      return previousStart.then(() => {
        if (this.disposed || this.generation !== restartGeneration)
          return false;
        return this.start();
      });
    }
    if (this.transitionPending) return Promise.resolve(false);
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

  private async startInternal(): Promise<boolean> {
    this.transitionPending = true;
    const generation = ++this.generation;
    this.clearInput();
    const previousSessionId = this.backendSessionId;
    this.backendSessionId = null;
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.error = null;
    this.status = "starting";
    this.onChange();

    if (previousSessionId) {
      try {
        await stopWorkspaceTerminal(previousSessionId);
      } catch (failure) {
        if (!this.disposed && this.generation === generation) {
          this.transitionPending = false;
          this.setError(failure);
        }
        return false;
      }
    }
    if (this.disposed || this.generation !== generation) return false;
    await this.waitForTerminalWrites();
    if (this.disposed || this.generation !== generation) return false;
    this.terminal.reset();

    let exitedBeforeStartResolved = false;
    let failedBeforeStartResolved = false;
    const handleEvent = (event: WorkspaceTerminalEvent): void => {
      if (this.disposed || this.generation !== generation) return;
      switch (event.type) {
        case "output":
          this.attachBackendSession(event.sessionId, generation);
          const outputByteLength = decodedBase64ByteLength(event.data);
          try {
            const output = decodeTerminalOutput(event.data);
            this.writeTerminal(output, () =>
              this.queueOutputAcknowledgement(
                event.sessionId,
                output.byteLength,
              ),
            );
          } catch (failure) {
            this.queueOutputAcknowledgement(event.sessionId, outputByteLength);
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
          this.clearInput();
          this.status = "exited";
          const exitCode =
            typeof event.exitCode === "number" ? event.exitCode : null;
          this.writeTerminal(
            `\r\n\x1b[90m[Process exited${
              exitCode === null ? "" : ` with code ${exitCode}`
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
        return false;
      }
      if (!exitedBeforeStartResolved) {
        this.attachBackendSession(started.sessionId, generation);
        this.status = failedBeforeStartResolved ? "error" : "running";
        this.onChange();
        try {
          await resizeWorkspaceTerminal(
            started.sessionId,
            Math.max(2, this.terminal.cols),
            Math.max(1, this.terminal.rows),
          );
        } catch (failure) {
          failedBeforeStartResolved = true;
          if (this.backendSessionId === started.sessionId) {
            this.setError(failure);
          }
        }
        return (
          !failedBeforeStartResolved &&
          !exitedBeforeStartResolved &&
          this.backendSessionId === started.sessionId
        );
      }
      return false;
    } catch (failure) {
      if (!this.disposed && this.generation === generation) {
        const provisionalSessionId = this.backendSessionId;
        this.backendSessionId = null;
        this.clearInput();
        if (provisionalSessionId) {
          await stopWorkspaceTerminal(provisionalSessionId).catch(() => {});
        }
        this.setError(failure);
      }
      return false;
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
    this.clearInput();
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
    this.clearInput();
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    const sessionId = this.backendSessionId;
    const startPromise = this.startPromise;
    this.backendSessionId = null;
    for (const disposable of this.disposables) disposable.dispose();
    this.pendingTerminalWrites = 0;
    for (const resolve of this.terminalWriteWaiters) resolve();
    this.terminalWriteWaiters.clear();
    this.terminal.dispose();
    const cleanup: Array<Promise<unknown> | null> = [startPromise];
    if (stopBackend && sessionId) {
      cleanup.push(stopWorkspaceTerminal(sessionId));
    }
    const results = await Promise.allSettled(
      cleanup.filter((operation): operation is Promise<unknown> => !!operation),
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
  private profileSettings: TerminalProfileSettings = {
    ...DEFAULT_TERMINAL_PROFILE_SETTINGS,
  };
  private profiles: ResolvedTerminalProfiles | null = null;
  private profileSettingsMutation: Promise<void> = Promise.resolve();
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
      profiles: this.profiles,
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
    this.initializePromise = (async () => {
      try {
        const [discovery, settingsResult] = await Promise.all([
          discoverWorkspaceShells(),
          loadTerminalProfileSettings()
            .then((settings) => ({ settings, error: null }))
            .catch((error: unknown) => ({
              settings: { ...DEFAULT_TERMINAL_PROFILE_SETTINGS },
              error,
            })),
        ]);
        if (this.disposed) return;
        this.discovery = discovery;
        const profiles = resolveTerminalProfiles(
          settingsResult.settings,
          discovery,
        );
        this.profileSettings = profiles.settings;
        this.profiles = profiles;
        if (settingsResult.error) {
          this.discoveryError = errorMessage(settingsResult.error);
        }
        this.publish();
        if (
          !settingsResult.error &&
          !terminalProfileSettingsEqual(
            settingsResult.settings,
            profiles.settings,
          )
        ) {
          try {
            await saveTerminalProfileSettings(profiles.settings);
          } catch (failure) {
            if (!this.disposed) {
              this.discoveryError = errorMessage(failure);
              this.publish();
            }
          }
        }
        await this.profileSettingsMutation;
        if (this.disposed) return;
        const startupProfiles = this.profiles ?? profiles;
        const preferredShell = startupProfiles.visibleShells.find(
          (shell) => shell.id === startupProfiles.defaultShellId,
        );
        const startupOrder = preferredShell
          ? [
              preferredShell,
              ...startupProfiles.visibleShells.filter(
                (shell) => shell.id !== preferredShell.id,
              ),
            ]
          : startupProfiles.visibleShells;
        if (this.terminals.length === 0) {
          for (const [index, shell] of startupOrder.entries()) {
            const attempt = await this.createTerminalSession(shell.id);
            if (!attempt || attempt.started || this.disposed) return;
            if (index === startupOrder.length - 1) return;

            const terminalIndex = this.terminals.indexOf(attempt.terminal);
            if (terminalIndex >= 0) this.terminals.splice(terminalIndex, 1);
            if (this.nextOrdinal === attempt.terminal.ordinal + 1) {
              this.nextOrdinal -= 1;
            }
            if (this.activeTerminalId === attempt.terminal.id) {
              this.activeTerminalId = null;
            }
            this.publish();
            await attempt.terminal.dispose(true).catch(() => {});
          }
        }
      } catch (failure) {
        if (this.disposed) return;
        this.discoveryError = errorMessage(failure);
        this.publish();
      }
    })();
    return this.initializePromise;
  }

  private async createTerminalSession(shellId: string): Promise<{
    terminal: WorkspaceTerminalSession;
    started: boolean;
  } | null> {
    const shell = this.profiles?.visibleShells.find(
      (candidate) => candidate.id === shellId,
    );
    if (!shell || this.disposed) return null;
    const terminal = new WorkspaceTerminalSession(
      this.workspaceRoot,
      shell,
      this.discovery?.platform ?? "unknown",
      this.nextOrdinal,
      this.publish,
    );
    this.nextOrdinal += 1;
    this.terminals.push(terminal);
    this.activeTerminalId = terminal.id;
    this.publish();
    const started = await terminal.start();
    return { terminal, started };
  }

  async createTerminal(shellId: string): Promise<void> {
    if (this.disposed) return;
    if (!this.discovery) await this.initialize();
    await this.createTerminalSession(shellId);
  }

  private updateProfileSettings(
    update: (
      profiles: ResolvedTerminalProfiles,
    ) => TerminalProfileSettings | null,
  ): Promise<void> {
    const operation = this.profileSettingsMutation.then(async () => {
      if (!this.discovery || this.disposed) return;
      const current = resolveTerminalProfiles(
        this.profileSettings,
        this.discovery,
      );
      const requestedSettings = update(current);
      if (!requestedSettings) return;
      const next = resolveTerminalProfiles(requestedSettings, this.discovery);
      if (terminalProfileSettingsEqual(current.settings, next.settings)) {
        return;
      }

      await saveTerminalProfileSettings(next.settings);
      if (this.disposed) return;
      this.profileSettings = next.settings;
      this.profiles = next;
      this.publish();
    });

    this.profileSettingsMutation = operation.catch((failure: unknown) => {
      if (this.disposed) return;
      this.discoveryError = errorMessage(failure);
      this.publish();
    });
    return this.profileSettingsMutation;
  }

  setShellVisibility(shellId: string, visible: boolean): Promise<void> {
    return this.updateProfileSettings((profiles) => {
      if (!profiles.availableShells.some((shell) => shell.id === shellId)) {
        return null;
      }
      const visibleShellIds = profiles.visibleShells.map((shell) => shell.id);
      const currentlyVisible = visibleShellIds.includes(shellId);
      if (
        visible === currentlyVisible ||
        (!visible && visibleShellIds.length <= 1)
      ) {
        return null;
      }

      return {
        ...profiles.settings,
        visibleShellIds: visible
          ? [...visibleShellIds, shellId]
          : visibleShellIds.filter((candidate) => candidate !== shellId),
      };
    });
  }

  setDefaultShell(shellId: string): Promise<void> {
    return this.updateProfileSettings((profiles) => {
      if (!profiles.visibleShells.some((shell) => shell.id === shellId)) {
        return null;
      }
      return { ...profiles.settings, defaultShellId: shellId };
    });
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

  unmountTerminal(terminalId: string): void {
    this.terminals.find((terminal) => terminal.id === terminalId)?.unmount();
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
