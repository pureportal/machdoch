import { vi } from "vitest";

export type DesktopEventHandler = (event: { payload: unknown }) => void;

export const isTauriMock = vi.fn(() => true);
export const openMock = vi.fn().mockResolvedValue("/mocked/tauri/path");
export const openUrlMock = vi.fn().mockResolvedValue(undefined);
export const desktopEventListeners = new Map<string, DesktopEventHandler>();
export const listenMock = vi.fn(
  async (eventName: string, handler: DesktopEventHandler) => {
    desktopEventListeners.set(eventName, handler);

    return () => {
      desktopEventListeners.delete(eventName);
    };
  },
);

export const isTauri = isTauriMock;
export const listen = listenMock;
export const open = openMock;
export const openUrl = openUrlMock;
export const invoke = undefined;
