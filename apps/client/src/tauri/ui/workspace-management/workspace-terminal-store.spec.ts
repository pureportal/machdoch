import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTerminalEvent } from "../runtime";

interface StartedTerminal {
  sessionId: string;
  shellId: string;
  processId: number | null;
}

type StartTerminal = (
  workspaceRoot: string,
  shellId: string,
  columns: number,
  rows: number,
  onEvent: (event: WorkspaceTerminalEvent) => void,
) => Promise<StartedTerminal>;

const runtimeMocks = vi.hoisted(() => ({
  acknowledgeWorkspaceTerminalOutput: vi.fn<
    (sessionId: string, bytes: number) => Promise<void>
  >(async () => {}),
  discoverWorkspaceShells: vi.fn<() => Promise<unknown>>(),
  resizeWorkspaceTerminal: vi.fn<
    (sessionId: string, columns: number, rows: number) => Promise<void>
  >(async () => {}),
  startWorkspaceTerminal: vi.fn<StartTerminal>(),
  stopWorkspaceTerminal: vi.fn<(sessionId: string) => Promise<void>>(
    async () => {},
  ),
  stopWorkspaceTerminals: vi.fn<(workspaceRoot: string) => Promise<number>>(
    async () => 0,
  ),
  writeWorkspaceTerminal: vi.fn<
    (sessionId: string, data: string) => Promise<void>
  >(async () => {}),
  writeWorkspaceTerminalBinary: vi.fn<
    (sessionId: string, data: string) => Promise<void>
  >(async () => {}),
}));

const profileSettingsMocks = vi.hoisted(() => ({
  loadTerminalProfileSettings: vi.fn<() => Promise<unknown>>(),
  saveTerminalProfileSettings: vi.fn<(settings: unknown) => Promise<void>>(
    async () => {},
  ),
}));

const xtermState = vi.hoisted(() => ({
  writes: [] as Array<string | Uint8Array>,
  autoProcessWrites: true,
  elements: [] as Array<{
    parentElement: unknown;
    remove: ReturnType<typeof vi.fn>;
  }>,
  instances: [] as Array<{
    options: Record<string, unknown>;
    dataHandlers: Array<(data: string) => void>;
    binaryHandlers: Array<(data: string) => void>;
    resizeHandlers: Array<(size: { cols: number; rows: number }) => void>;
    titleHandlers: Array<(title: string) => void>;
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    writeCallbacks: Array<() => void>;
    pasted: string[];
    resetCount: number;
  }>,
}));

vi.mock("../runtime", () => runtimeMocks);

vi.mock("../lib/shell-store", () => ({
  DEFAULT_TERMINAL_PROFILE_SETTINGS: {
    version: 1,
    visibleShellIds: null,
    defaultShellId: null,
  },
  loadTerminalProfileSettings: profileSettingsMocks.loadTerminalProfileSettings,
  saveTerminalProfileSettings: profileSettingsMocks.saveTerminalProfileSettings,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly cols = 80;
    readonly rows = 24;
    element: {
      parentElement: unknown;
      remove: ReturnType<typeof vi.fn>;
    } | null = null;
    private readonly state;

    constructor(options: Record<string, unknown>) {
      this.state = {
        options,
        dataHandlers: [] as Array<(data: string) => void>,
        binaryHandlers: [] as Array<(data: string) => void>,
        resizeHandlers: [] as Array<
          (size: { cols: number; rows: number }) => void
        >,
        titleHandlers: [] as Array<(title: string) => void>,
        keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
        writeCallbacks: [] as Array<() => void>,
        pasted: [] as string[],
        resetCount: 0,
      };
      xtermState.instances.push(this.state);
    }

    loadAddon(): void {}
    open(container: HTMLDivElement): void {
      const element = {
        parentElement: container as unknown,
        remove: vi.fn(() => {
          element.parentElement = null;
        }),
      };
      this.element = element;
      xtermState.elements.push(element);
    }
    attachCustomKeyEventHandler(
      handler: (event: KeyboardEvent) => boolean,
    ): void {
      this.state.keyHandler = handler;
    }
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.state.dataHandlers.push(handler);
      return { dispose: () => {} };
    }
    onBinary(handler: (data: string) => void): { dispose: () => void } {
      this.state.binaryHandlers.push(handler);
      return { dispose: () => {} };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void): {
      dispose: () => void;
    } {
      this.state.resizeHandlers.push(handler);
      return { dispose: () => {} };
    }
    onTitleChange(handler: (title: string) => void): { dispose: () => void } {
      this.state.titleHandlers.push(handler);
      return { dispose: () => {} };
    }
    reset(): void {
      this.state.resetCount += 1;
    }
    write(data: string | Uint8Array, callback?: () => void): void {
      xtermState.writes.push(data);
      if (callback) {
        if (xtermState.autoProcessWrites) callback();
        else this.state.writeCallbacks.push(callback);
      }
    }
    hasSelection(): boolean {
      return false;
    }
    getSelection(): string {
      return "";
    }
    paste(data: string): void {
      this.state.pasted.push(data);
    }
    focus(): void {}
    clear(): void {}
    dispose(): void {}
  },
}));

import { WorkspaceTerminalStore } from "./workspace-terminal-store";

const discovery = {
  platform: "windows",
  defaultShellId: "windows-powershell",
  externalTerminal: null,
  shells: [
    {
      id: "windows-powershell",
      label: "Windows PowerShell",
      kind: "powershell",
    },
    { id: "cmd", label: "Command Prompt", kind: "cmd" },
  ],
};

describe("WorkspaceTerminalStore shell startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.discoverWorkspaceShells.mockReset();
    runtimeMocks.startWorkspaceTerminal.mockReset();
    runtimeMocks.acknowledgeWorkspaceTerminalOutput
      .mockReset()
      .mockResolvedValue(undefined);
    runtimeMocks.resizeWorkspaceTerminal
      .mockReset()
      .mockResolvedValue(undefined);
    runtimeMocks.stopWorkspaceTerminal.mockReset().mockResolvedValue(undefined);
    runtimeMocks.stopWorkspaceTerminals.mockReset().mockResolvedValue(0);
    runtimeMocks.writeWorkspaceTerminal
      .mockReset()
      .mockResolvedValue(undefined);
    runtimeMocks.writeWorkspaceTerminalBinary
      .mockReset()
      .mockResolvedValue(undefined);
    runtimeMocks.discoverWorkspaceShells.mockResolvedValue(discovery);
    profileSettingsMocks.loadTerminalProfileSettings
      .mockReset()
      .mockResolvedValue({
        version: 1,
        visibleShellIds: null,
        defaultShellId: null,
      });
    profileSettingsMocks.saveTerminalProfileSettings
      .mockReset()
      .mockResolvedValue(undefined);
    xtermState.writes.length = 0;
    xtermState.instances.length = 0;
    xtermState.elements.length = 0;
    xtermState.autoProcessWrites = true;
  });

  it("falls back when the preferred shell cannot stay running", async () => {
    runtimeMocks.startWorkspaceTerminal
      .mockRejectedValueOnce(
        new Error("Windows PowerShell exited during startup with code 7."),
      )
      .mockResolvedValueOnce({
        sessionId: "cmd-session",
        shellId: "cmd",
        processId: 42,
      });
    const store = new WorkspaceTerminalStore("C:\\Workspace With Spaces");

    await store.initialize();

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.startWorkspaceTerminal.mock.calls[0]?.[1]).toBe(
      "windows-powershell",
    );
    expect(runtimeMocks.startWorkspaceTerminal.mock.calls[1]?.[1]).toBe("cmd");
    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({
        label: "Command Prompt 1",
        shellId: "cmd",
        status: "running",
        error: null,
      }),
    ]);
  });

  it("detaches the terminal element when its workspace view unmounts", async () => {
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "terminal-session",
      shellId: "windows-powershell",
      processId: 42,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();
    const terminalId = store.getSnapshot().activeTerminalId;
    const container = {} as HTMLDivElement;

    store.mountTerminal(terminalId!, container);
    store.unmountTerminal(terminalId!);

    expect(xtermState.elements).toHaveLength(1);
    expect(xtermState.elements[0]?.remove).toHaveBeenCalledOnce();
    expect(xtermState.elements[0]?.parentElement).toBeNull();
  });

  it("starts the persisted visible default and hides other launch profiles", async () => {
    profileSettingsMocks.loadTerminalProfileSettings.mockResolvedValue({
      version: 1,
      visibleShellIds: ["cmd"],
      defaultShellId: "cmd",
    });
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "cmd-session",
      shellId: "cmd",
      processId: 42,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.startWorkspaceTerminal.mock.calls[0]?.[1]).toBe("cmd");
    expect(
      store.getSnapshot().profiles?.availableShells.map((shell) => shell.id),
    ).toEqual(["windows-powershell", "cmd"]);
    expect(
      store.getSnapshot().profiles?.visibleShells.map((shell) => shell.id),
    ).toEqual(["cmd"]);
    expect(store.getSnapshot().profiles?.defaultShellId).toBe("cmd");
    expect(
      profileSettingsMocks.saveTerminalProfileSettings,
    ).not.toHaveBeenCalled();
  });

  it("repairs unavailable persisted profiles before starting a terminal", async () => {
    profileSettingsMocks.loadTerminalProfileSettings.mockResolvedValue({
      version: 1,
      visibleShellIds: ["removed", "cmd"],
      defaultShellId: "removed",
    });
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "cmd-session",
      shellId: "cmd",
      processId: 42,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(
      profileSettingsMocks.saveTerminalProfileSettings,
    ).toHaveBeenCalledWith({
      version: 1,
      visibleShellIds: ["cmd"],
      defaultShellId: null,
    });
    expect(runtimeMocks.startWorkspaceTerminal.mock.calls[0]?.[1]).toBe("cmd");
  });

  it("falls back when the selected default is hidden and keeps one profile visible", async () => {
    profileSettingsMocks.loadTerminalProfileSettings.mockResolvedValue({
      version: 1,
      visibleShellIds: null,
      defaultShellId: "cmd",
    });
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "cmd-session",
      shellId: "cmd",
      processId: 42,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();

    await store.setShellVisibility("cmd", false);

    expect(
      profileSettingsMocks.saveTerminalProfileSettings,
    ).toHaveBeenLastCalledWith({
      version: 1,
      visibleShellIds: ["windows-powershell"],
      defaultShellId: null,
    });
    expect(store.getSnapshot().profiles?.defaultShellId).toBe(
      "windows-powershell",
    );

    await store.setShellVisibility("windows-powershell", false);

    expect(
      profileSettingsMocks.saveTerminalProfileSettings,
    ).toHaveBeenCalledTimes(1);
    expect(
      store.getSnapshot().profiles?.visibleShells.map((shell) => shell.id),
    ).toEqual(["windows-powershell"]);
  });

  it("persists a visible default selection", async () => {
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "powershell-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();

    await store.setDefaultShell("cmd");

    expect(
      profileSettingsMocks.saveTerminalProfileSettings,
    ).toHaveBeenCalledWith({
      version: 1,
      visibleShellIds: null,
      defaultShellId: "cmd",
    });
    expect(store.getSnapshot().profiles?.defaultShellId).toBe("cmd");
  });

  it("keeps the final actionable failure when no shell starts", async () => {
    runtimeMocks.startWorkspaceTerminal
      .mockRejectedValueOnce(new Error("PowerShell startup failed."))
      .mockRejectedValueOnce(new Error("Command Prompt startup failed."));
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({
        label: "Command Prompt 1",
        shellId: "cmd",
        status: "error",
        error: "Command Prompt startup failed.",
      }),
    ]);
  });

  it("stops an unusable session and falls back after an immediate backend error", async () => {
    runtimeMocks.startWorkspaceTerminal
      .mockImplementationOnce(
        async (
          _workspaceRoot: string,
          _shellId: string,
          _columns: number,
          _rows: number,
          onEvent: (event: WorkspaceTerminalEvent) => void,
        ) => {
          onEvent({ type: "error", message: "Terminal output stopped." });
          return {
            sessionId: "unusable-powershell-session",
            shellId: "windows-powershell",
            processId: 41,
          };
        },
      )
      .mockResolvedValueOnce({
        sessionId: "cmd-session",
        shellId: "cmd",
        processId: 42,
      });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
      "unusable-powershell-session",
    );
    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({ shellId: "cmd", status: "running" }),
    ]);
  });

  it("does not render an undefined exit code while falling back", async () => {
    runtimeMocks.startWorkspaceTerminal
      .mockImplementationOnce(
        async (
          _workspaceRoot: string,
          _shellId: string,
          _columns: number,
          _rows: number,
          onEvent: (event: WorkspaceTerminalEvent) => void,
        ) => {
          onEvent({ type: "exit" } as unknown as WorkspaceTerminalEvent);
          return {
            sessionId: "exited-powershell-session",
            shellId: "windows-powershell",
            processId: 41,
          };
        },
      )
      .mockResolvedValueOnce({
        sessionId: "cmd-session",
        shellId: "cmd",
        processId: 42,
      });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(
      xtermState.writes
        .filter((value): value is string => typeof value === "string")
        .join(""),
    ).not.toContain("undefined");
    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({ shellId: "cmd", status: "running" }),
    ]);
  });

  it("falls back when the first shell exits during its initial resize", async () => {
    let firstShellEvent: ((event: WorkspaceTerminalEvent) => void) | null =
      null;
    runtimeMocks.startWorkspaceTerminal
      .mockImplementationOnce(
        async (
          _workspaceRoot: string,
          _shellId: string,
          _columns: number,
          _rows: number,
          onEvent: (event: WorkspaceTerminalEvent) => void,
        ) => {
          firstShellEvent = onEvent;
          return {
            sessionId: "short-lived-session",
            shellId: "windows-powershell",
            processId: 41,
          };
        },
      )
      .mockResolvedValueOnce({
        sessionId: "cmd-session",
        shellId: "cmd",
        processId: 42,
      });
    runtimeMocks.resizeWorkspaceTerminal.mockImplementationOnce(async () => {
      firstShellEvent?.({ type: "exit", exitCode: 9 });
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({ shellId: "cmd", status: "running" }),
    ]);
  });

  it("falls back when a started shell cannot be resized", async () => {
    runtimeMocks.startWorkspaceTerminal
      .mockResolvedValueOnce({
        sessionId: "unresizable-session",
        shellId: "windows-powershell",
        processId: 41,
      })
      .mockResolvedValueOnce({
        sessionId: "cmd-session",
        shellId: "cmd",
        processId: 42,
      });
    runtimeMocks.resizeWorkspaceTerminal
      .mockRejectedValueOnce(new Error("The PTY resize failed."))
      .mockResolvedValueOnce(undefined);
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
      "unresizable-session",
    );
    expect(store.getSnapshot().terminals).toEqual([
      expect.objectContaining({ shellId: "cmd", status: "running" }),
    ]);
  });

  it("preserves navigation, control, and binary input byte-for-byte", async () => {
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "interactive-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();
    const terminal = xtermState.instances[0];

    terminal?.dataHandlers[0]?.("\x1b[A");
    terminal?.dataHandlers[0]?.("\x1b[1;5D");
    terminal?.dataHandlers[0]?.("\x03");
    terminal?.binaryHandlers[0]?.("\x1b[M\x80\xff\0");

    await vi.waitFor(() => {
      expect(runtimeMocks.writeWorkspaceTerminal).toHaveBeenCalledTimes(1);
      expect(runtimeMocks.writeWorkspaceTerminalBinary).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(runtimeMocks.writeWorkspaceTerminal).toHaveBeenCalledWith(
      "interactive-session",
      "\x1b[A\x1b[1;5D\x03",
    );
    expect(runtimeMocks.writeWorkspaceTerminalBinary).toHaveBeenCalledWith(
      "interactive-session",
      "\x1b[M\x80\xff\0",
    );
    expect(
      terminal?.keyHandler?.({
        type: "keydown",
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
      } as KeyboardEvent),
    ).toBe(true);
  });

  it("accepts buffered input before the start invoke resolves", async () => {
    const eventHandlers: Array<(event: WorkspaceTerminalEvent) => void> = [];
    const deferred: {
      resolve: ((started: StartedTerminal) => void) | null;
    } = { resolve: null };
    runtimeMocks.startWorkspaceTerminal.mockImplementation(
      (
        _workspaceRoot: string,
        _shellId: string,
        _columns: number,
        _rows: number,
        onEvent: (event: WorkspaceTerminalEvent) => void,
      ) => {
        eventHandlers.push(onEvent);
        return new Promise((resolve) => {
          deferred.resolve = resolve;
        });
      },
    );
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    const initialize = store.initialize();
    await vi.waitFor(() => expect(eventHandlers).toHaveLength(1));
    const terminal = xtermState.instances[0];

    terminal?.dataHandlers[0]?.("\x1b[1;1R");
    eventHandlers[0]?.({
      type: "output",
      sessionId: "starting-session",
      data: Buffer.from("\x1b[6n").toString("base64"),
    });

    await vi.waitFor(() => {
      expect(runtimeMocks.writeWorkspaceTerminal).toHaveBeenCalledWith(
        "starting-session",
        "\x1b[1;1R",
      );
    });
    expect(store.getSnapshot().terminals[0]).toEqual(
      expect.objectContaining({
        sessionActive: true,
        status: "starting",
      }),
    );

    deferred.resolve?.({
      sessionId: "starting-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    await initialize;
    expect(store.getSnapshot().terminals[0]?.status).toBe("running");
  });

  it("streams large Unicode pastes in bounded character-safe chunks", async () => {
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "paste-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();
    const pasted = `prefix-${"\u{1f600}\u6f22\u5b57".repeat(20_000)}-suffix`;

    xtermState.instances[0]?.dataHandlers[0]?.(pasted);

    await vi.waitFor(() => {
      expect(
        runtimeMocks.writeWorkspaceTerminal.mock.calls.length,
      ).toBeGreaterThan(1);
    });
    const chunks = runtimeMocks.writeWorkspaceTerminal.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(chunks.join("")).toBe(pasted);
    expect(
      chunks.every(
        (chunk) => new TextEncoder().encode(chunk).byteLength <= 48 * 1024,
      ),
    ).toBe(true);
    expect(store.getSnapshot().terminals[0]?.status).toBe("running");
  });

  it("batches high-volume render acknowledgements without losing bytes", async () => {
    const eventHandlers: Array<(event: WorkspaceTerminalEvent) => void> = [];
    runtimeMocks.startWorkspaceTerminal.mockImplementation(
      async (
        _workspaceRoot: string,
        _shellId: string,
        _columns: number,
        _rows: number,
        callback: (event: WorkspaceTerminalEvent) => void,
      ) => {
        eventHandlers.push(callback);
        return {
          sessionId: "output-session",
          shellId: "windows-powershell",
          processId: 41,
        };
      },
    );
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();
    const output = Uint8Array.from(
      { length: 16 * 1024 },
      (_, index) => index % 251,
    );
    const encoded = Buffer.from(output).toString("base64");

    for (let index = 0; index < 64; index += 1) {
      eventHandlers[0]?.({
        type: "output",
        sessionId: "output-session",
        data: encoded,
      });
    }

    await vi.waitFor(() => {
      expect(
        runtimeMocks.acknowledgeWorkspaceTerminalOutput,
      ).toHaveBeenCalledTimes(4);
    });
    const acknowledged =
      runtimeMocks.acknowledgeWorkspaceTerminalOutput.mock.calls.reduce(
        (total, call) => total + Number(call[1]),
        0,
      );
    expect(acknowledged).toBe(64 * output.byteLength);
    expect(
      runtimeMocks.acknowledgeWorkspaceTerminalOutput.mock.calls.every(
        (call) => Number(call[1]) <= 256 * 1024,
      ),
    ).toBe(true);
    expect(
      xtermState.writes.filter((value) => value instanceof Uint8Array),
    ).toHaveLength(64);
  });

  it("drains queued xterm output before resetting a restarted session", async () => {
    const eventHandlers: Array<(event: WorkspaceTerminalEvent) => void> = [];
    runtimeMocks.startWorkspaceTerminal
      .mockImplementationOnce(
        async (
          _workspaceRoot: string,
          _shellId: string,
          _columns: number,
          _rows: number,
          callback: (event: WorkspaceTerminalEvent) => void,
        ) => {
          eventHandlers.push(callback);
          return {
            sessionId: "first-session",
            shellId: "windows-powershell",
            processId: 41,
          };
        },
      )
      .mockResolvedValueOnce({
        sessionId: "second-session",
        shellId: "windows-powershell",
        processId: 42,
      });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();
    xtermState.autoProcessWrites = false;
    eventHandlers[0]?.({
      type: "output",
      sessionId: "first-session",
      data: Buffer.from("queued output").toString("base64"),
    });

    const restart = store.startActiveTerminal();
    await vi.waitFor(() => {
      expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
        "first-session",
      );
    });
    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(1);

    xtermState.instances[0]?.writeCallbacks.shift()?.();
    await restart;

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    expect(xtermState.instances[0]?.resetCount).toBe(2);
  });

  it("serializes a rapid stop and restart while startup is unresolved", async () => {
    const pendingStart: {
      resolve: ((started: StartedTerminal) => void) | null;
    } = { resolve: null };
    runtimeMocks.startWorkspaceTerminal
      .mockResolvedValueOnce({
        sessionId: "initial-session",
        shellId: "windows-powershell",
        processId: 40,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pendingStart.resolve = resolve;
          }),
      )
      .mockResolvedValueOnce({
        sessionId: "replacement-session",
        shellId: "windows-powershell",
        processId: 42,
      });
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();

    const interruptedRestart = store.startActiveTerminal();
    await vi.waitFor(() => {
      expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    });
    await store.stopActiveTerminal();
    const replacementRestart = store.startActiveTerminal();

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    pendingStart.resolve?.({
      sessionId: "cancelled-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    await interruptedRestart;
    await replacementRestart;

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
      "initial-session",
    );
    expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
      "cancelled-session",
    );
    expect(store.getSnapshot().terminals[0]).toEqual(
      expect.objectContaining({
        sessionActive: true,
        status: "running",
      }),
    );
  });

  it("cancels a queued restart when stop is pressed again", async () => {
    const pendingStart: {
      resolve: ((started: StartedTerminal) => void) | null;
    } = { resolve: null };
    runtimeMocks.startWorkspaceTerminal
      .mockResolvedValueOnce({
        sessionId: "initial-session",
        shellId: "windows-powershell",
        processId: 40,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pendingStart.resolve = resolve;
          }),
      );
    const store = new WorkspaceTerminalStore("C:\\Workspace");
    await store.initialize();

    const interruptedRestart = store.startActiveTerminal();
    await vi.waitFor(() => {
      expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    });
    await store.stopActiveTerminal();
    const queuedRestart = store.startActiveTerminal();
    await store.stopActiveTerminal();
    pendingStart.resolve?.({
      sessionId: "cancelled-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    await interruptedRestart;
    await queuedRestart;

    expect(runtimeMocks.startWorkspaceTerminal).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.stopWorkspaceTerminal).toHaveBeenCalledWith(
      "cancelled-session",
    );
    expect(store.getSnapshot().terminals[0]).toEqual(
      expect.objectContaining({ sessionActive: false, status: "exited" }),
    );
  });

  it("enables ConPTY resize compatibility and practical scrollback on Windows", async () => {
    runtimeMocks.startWorkspaceTerminal.mockResolvedValue({
      sessionId: "configured-session",
      shellId: "windows-powershell",
      processId: 41,
    });
    const store = new WorkspaceTerminalStore("C:\\Workspace");

    await store.initialize();

    expect(xtermState.instances[0]?.options).toEqual(
      expect.objectContaining({
        scrollback: 10_000,
        windowsPty: { backend: "conpty" },
      }),
    );
  });
});
