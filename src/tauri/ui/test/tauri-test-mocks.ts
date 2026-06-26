import { vi } from "vitest";

export type DesktopEventHandler = (event: { payload: unknown }) => void;
export type WindowEventHandler<T = unknown> = (event: { payload: T }) => void;

export type DragDropEvent =
  | { type: "enter"; paths: string[]; position: PhysicalPosition }
  | { type: "over"; position: PhysicalPosition }
  | { type: "drop"; paths: string[]; position: PhysicalPosition }
  | { type: "leave" };

export interface MonitorMock {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
  scaleFactor: number;
}

export const isTauriMock = vi.fn(() => true);
type TauriInvoke = <T = unknown>(command: string, args?: unknown) => Promise<T>;

export const invokeMock = vi.fn();
export let invoke: TauriInvoke | undefined = undefined;

export const enableInvokeMock = (): void => {
  invoke = invokeMock as TauriInvoke;
};

export const disableInvokeMock = (): void => {
  invoke = undefined;
};

export const openMock = vi.fn().mockResolvedValue("/mocked/tauri/path");
export const openUrlMock = vi.fn().mockResolvedValue(undefined);
export const desktopEventListeners = new Map<string, DesktopEventHandler>();
export const windowDragDropListeners = new Set<WindowEventHandler<DragDropEvent>>();
export const windowFocusChangedListeners = new Set<WindowEventHandler<boolean>>();
export const listenMock = vi.fn(
  async (eventName: string, handler: DesktopEventHandler) => {
    desktopEventListeners.set(eventName, handler);

    return () => {
      desktopEventListeners.delete(eventName);
    };
  },
);

export class PhysicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

export class PhysicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

const createWindowHandle = (label: string) => ({
  label,
  close: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
  emitTo: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  isMinimized: vi.fn().mockResolvedValue(false),
  isVisible: vi.fn().mockResolvedValue(true),
  listen: listenMock,
  maximize: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  onDragDropEvent: vi.fn(
    async (handler: WindowEventHandler<DragDropEvent>) => {
      windowDragDropListeners.add(handler);

      return () => {
        windowDragDropListeners.delete(handler);
      };
    },
  ),
  onFocusChanged: vi.fn(async (handler: WindowEventHandler<boolean>) => {
    windowFocusChangedListeners.add(handler);

    return () => {
      windowFocusChangedListeners.delete(handler);
    };
  }),
  setFocus: vi.fn().mockResolvedValue(undefined),
  setPosition: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  unmaximize: vi.fn().mockResolvedValue(undefined),
  unminimize: vi.fn().mockResolvedValue(undefined),
});

export const currentWindowMock = createWindowHandle("main");

export class Window {
  static getByLabel = vi.fn(async (label: string) => createWindowHandle(label));

  label: string;

  constructor(label: string) {
    this.label = label;
  }
}

export const getCurrentWindow = vi.fn(() => currentWindowMock);

export const cursorPosition = vi.fn(async () => new PhysicalPosition(0, 0));
export const currentMonitor = vi.fn(
  async (): Promise<MonitorMock | null> => null,
);
export const monitorFromPoint = vi.fn(
  async (): Promise<MonitorMock | null> => null,
);

export const isTauri = isTauriMock;
export const listen = listenMock;
export const open = openMock;
export const openUrl = openUrlMock;
