import { type Mock, vi } from "vitest";

export type DesktopEventHandler = (event: { payload: unknown }) => void;
export type WindowEventHandler<T = unknown> = (event: { payload: T }) => void;
type WindowListenerCleanup = () => void;
type WindowEventListenerMock<T> = Mock<
  (handler: WindowEventHandler<T>) => Promise<WindowListenerCleanup>
>;
type WindowActionMock = Mock<(...args: unknown[]) => Promise<void>>;
type WindowValueMock<T> = Mock<() => Promise<T>>;

interface WindowHandle {
  label: string;
  close: WindowActionMock;
  emit: WindowActionMock;
  emitTo: WindowActionMock;
  hide: WindowActionMock;
  innerSize: WindowValueMock<PhysicalSize>;
  isMaximized: WindowValueMock<boolean>;
  isMinimized: WindowValueMock<boolean>;
  isVisible: WindowValueMock<boolean>;
  listen: typeof listenMock;
  maximize: WindowActionMock;
  minimize: WindowActionMock;
  onMoved: WindowEventListenerMock<PhysicalPosition>;
  onDragDropEvent: WindowEventListenerMock<DragDropEvent>;
  onFocusChanged: WindowEventListenerMock<boolean>;
  onResized: WindowEventListenerMock<PhysicalSize>;
  onScaleChanged: WindowEventListenerMock<{
    scaleFactor: number;
    size: PhysicalSize;
  }>;
  outerPosition: WindowValueMock<PhysicalPosition>;
  setFocus: WindowActionMock;
  setPosition: WindowActionMock;
  setSize: WindowActionMock;
  show: WindowActionMock;
  unmaximize: WindowActionMock;
  unminimize: WindowActionMock;
}

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
export const saveMock = vi
  .fn()
  .mockResolvedValue("/mocked/tauri/settings.machdoch-settings");
export const openUrlMock = vi.fn().mockResolvedValue(undefined);
export const convertFileSrcMock = vi.fn(
  (filePath: string, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
);
export const desktopEventListeners = new Map<string, DesktopEventHandler>();
export const windowDragDropListeners = new Set<WindowEventHandler<DragDropEvent>>();
export const windowFocusChangedListeners = new Set<WindowEventHandler<boolean>>();
export const windowMovedListeners = new Set<WindowEventHandler<PhysicalPosition>>();
export const windowResizedListeners = new Set<WindowEventHandler<PhysicalSize>>();
export const windowScaleChangedListeners = new Set<
  WindowEventHandler<{ scaleFactor: number; size: PhysicalSize }>
>();
export const listenMock = vi.fn(
  async (eventName: string, handler: DesktopEventHandler) => {
    desktopEventListeners.set(eventName, handler);

    return () => {
      desktopEventListeners.delete(eventName);
    };
  },
);

const createWindowEventListenerMock = <T>(
  listeners: Set<WindowEventHandler<T>>,
): WindowEventListenerMock<T> =>
  vi.fn(
    async (
      handler: WindowEventHandler<T>,
    ): Promise<WindowListenerCleanup> => {
      listeners.add(handler);

      return () => {
        listeners.delete(handler);
      };
    },
  );

const createResolvedWindowActionMock = (): WindowActionMock =>
  vi.fn().mockResolvedValue(undefined);

const createResolvedWindowValueMock = <T>(value: T): WindowValueMock<T> =>
  vi.fn().mockResolvedValue(value);

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

const createWindowHandle = (label: string): WindowHandle => ({
  label,
  close: createResolvedWindowActionMock(),
  emit: createResolvedWindowActionMock(),
  emitTo: createResolvedWindowActionMock(),
  hide: createResolvedWindowActionMock(),
  innerSize: createResolvedWindowValueMock(new PhysicalSize(0, 0)),
  isMaximized: createResolvedWindowValueMock(false),
  isMinimized: createResolvedWindowValueMock(false),
  isVisible: createResolvedWindowValueMock(true),
  listen: listenMock,
  maximize: createResolvedWindowActionMock(),
  minimize: createResolvedWindowActionMock(),
  onMoved: createWindowEventListenerMock(windowMovedListeners),
  onDragDropEvent: createWindowEventListenerMock(windowDragDropListeners),
  onFocusChanged: createWindowEventListenerMock(windowFocusChangedListeners),
  onResized: createWindowEventListenerMock(windowResizedListeners),
  onScaleChanged: createWindowEventListenerMock(windowScaleChangedListeners),
  outerPosition: createResolvedWindowValueMock(new PhysicalPosition(0, 0)),
  setFocus: createResolvedWindowActionMock(),
  setPosition: createResolvedWindowActionMock(),
  setSize: createResolvedWindowActionMock(),
  show: createResolvedWindowActionMock(),
  unmaximize: createResolvedWindowActionMock(),
  unminimize: createResolvedWindowActionMock(),
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
export const availableMonitors = vi.fn(async (): Promise<MonitorMock[]> => []);
export const currentMonitor = vi.fn(
  async (): Promise<MonitorMock | null> => null,
);
export const monitorFromPoint = vi.fn(
  async (): Promise<MonitorMock | null> => null,
);
export const primaryMonitor = vi.fn(
  async (): Promise<MonitorMock | null> => null,
);

export const isTauri = isTauriMock;
export const listen = listenMock;
export const open = openMock;
export const save = saveMock;
export const openUrl = openUrlMock;
export const convertFileSrc = convertFileSrcMock;
