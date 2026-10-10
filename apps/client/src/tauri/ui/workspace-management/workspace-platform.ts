import { invoke } from "../lib/analytics-invoke.js";
import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { WorkspaceRunSnapshot } from "../../../shared/workspace-run.js";
import type {
  WorkspaceFilePreview,
  WorkspaceTerminalEvent,
  WorkspaceTerminalEvents,
  WorkspaceTerminalStarted,
} from "@machdoch/fleet-protocol/workspace-contract";

interface RemoteTerminal {
  workspaceRoot: string;
  stopped: boolean;
  cursor: number;
  unreadBytes: number;
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onEvent: (event: WorkspaceTerminalEvent) => void;
}

class RemoteWorkspacePlatform {
  workspaceRoot: string | null = null;
  private readonly terminals = new Map<string, RemoteTerminal>();
  private readonly runSubscriptions = new Set<() => void>();

  constructor(
    readonly transport: FleetOperationTransport,
    readonly openRunUrl: (
      workspaceRoot: string,
      configurationId: string,
      url: string,
    ) => Promise<void>,
  ) {}

  subscribeRunState(
    workspaceRoot: string,
    listener: (snapshot: WorkspaceRunSnapshot) => void,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await this.transport.invoke<WorkspaceRunSnapshot>(
          "get_workspace_run_snapshot",
          { workspaceRoot },
        );
        if (!stopped) listener(snapshot);
      } catch (error) {
        if (!stopped)
          console.error("Could not refresh remote workspace runs", error);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      this.runSubscriptions.delete(stop);
    };
    this.runSubscriptions.add(stop);
    void poll();
    return stop;
  }

  async previewSource(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<string> {
    const file = await this.transport.invoke<WorkspaceFilePreview>(
      "read_workspace_file_preview",
      { workspaceRoot, relativePath },
    );
    const bytes = Uint8Array.from(atob(file.dataBase64), (character) =>
      character.charCodeAt(0),
    );
    return URL.createObjectURL(new Blob([bytes], { type: file.mediaType }));
  }

  async startTerminal(
    workspaceRoot: string,
    shellId: string,
    columns: number,
    rows: number,
    onEvent: (event: WorkspaceTerminalEvent) => void,
  ): Promise<WorkspaceTerminalStarted> {
    const started = await this.transport.invoke<WorkspaceTerminalStarted>(
      "start_workspace_terminal",
      {
        request: {
          workspaceRoot,
          shellId,
          columns: Math.round(columns),
          rows: Math.round(rows),
        },
      },
    );
    const terminal: RemoteTerminal = {
      workspaceRoot,
      cursor: 0,
      stopped: false,
      unreadBytes: 0,
      finished: false,
      onEvent,
    };
    this.terminals.set(started.sessionId, terminal);
    void this.poll(started.sessionId, terminal);
    return started;
  }

  private async poll(
    sessionId: string,
    terminal: RemoteTerminal,
  ): Promise<void> {
    if (terminal.stopped) return;
    try {
      const response = await this.transport.invoke<WorkspaceTerminalEvents>(
        "read_workspace_terminal_events",
        {
          workspaceRoot: terminal.workspaceRoot,
          sessionId,
          after: terminal.cursor,
        },
      );
      if (terminal.stopped) return;
      for (const event of response.events) {
        if (event.type === "output")
          terminal.unreadBytes += atob(event.data).length;
        terminal.onEvent(event);
        if (event.type === "exit" || event.type === "error") {
          terminal.finished = true;
          terminal.stopped = true;
        }
      }
      terminal.cursor = response.cursor;
      if (terminal.finished && terminal.unreadBytes === 0)
        await this.stopTerminal(sessionId);
    } catch (error) {
      if (!terminal.stopped)
        terminal.onEvent({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      terminal.stopped = true;
      await this.stopTerminal(sessionId).catch((cause: unknown) =>
        console.error("Could not close failed remote terminal", cause),
      );
    }
    if (!terminal.stopped)
      terminal.timer = setTimeout(
        () => void this.poll(sessionId, terminal),
        400,
      );
  }

  async terminalCommand(
    command: string,
    sessionId: string,
    args: Record<string, unknown> = {},
  ): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal)
      throw new Error("This remote terminal is no longer running.");
    await this.transport.invoke(command, {
      workspaceRoot: terminal.workspaceRoot,
      sessionId,
      ...args,
    });
    if (command === "acknowledge_workspace_terminal_output") {
      terminal.unreadBytes = Math.max(
        0,
        terminal.unreadBytes - Number(args.bytes),
      );
      if (terminal.finished && terminal.unreadBytes === 0)
        await this.stopTerminal(sessionId);
    }
  }

  async stopTerminal(sessionId: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) return;
    terminal.stopped = true;
    clearTimeout(terminal.timer);
    try {
      await this.terminalCommand("stop_workspace_terminal", sessionId);
    } finally {
      this.terminals.delete(sessionId);
    }
  }

  async stopTerminals(workspaceRoot: string): Promise<number> {
    const ids = [...this.terminals]
      .filter(([, terminal]) => terminal.workspaceRoot === workspaceRoot)
      .map(([id]) => id);
    await Promise.all(ids.map((id) => this.stopTerminal(id)));
    return ids.length;
  }

  async dispose(): Promise<void> {
    for (const stop of this.runSubscriptions) stop();
    const results = await Promise.allSettled(
      [...this.terminals.keys()].map((id) => this.stopTerminal(id)),
    );
    for (const result of results)
      if (result.status === "rejected")
        console.error("Could not close remote terminal", result.reason);
  }
}

let remotePlatform: RemoteWorkspacePlatform | null = null;

export function configureRemoteWorkspacePlatform(
  transport: FleetOperationTransport,
  openRunUrl: (
    workspaceRoot: string,
    configurationId: string,
    url: string,
  ) => Promise<void>,
): void {
  if (remotePlatform) throw new Error("A workspace host is already connected.");
  remotePlatform = new RemoteWorkspacePlatform(transport, openRunUrl);
}

export const getRemoteWorkspacePlatform = (): RemoteWorkspacePlatform | null =>
  remotePlatform;

export function invokeWorkspaceTools<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  return remotePlatform
    ? remotePlatform.transport.invoke<T>(command, args)
    : invoke<T>(command, args);
}
