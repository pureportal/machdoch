import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";

export const stopTitlebarEvent = (
  event: MouseEvent<HTMLButtonElement>,
): void => {
  event.preventDefault();
  event.stopPropagation();
};

export const minimizeDesktopWindow = async (): Promise<void> => {
  if (!isTauri()) {
    return;
  }

  try {
    await getCurrentWindow().minimize();
  } catch (error) {
    console.error("Failed to minimize window", error);
  }
};

export const toggleDesktopWindowMaximize = async (): Promise<void> => {
  if (!isTauri()) {
    return;
  }

  try {
    const currentWindow = getCurrentWindow();
    const shouldMaximize = !(await currentWindow.isMaximized());

    if (shouldMaximize) {
      await currentWindow.maximize();
      return;
    }

    await currentWindow.unmaximize();
  } catch (error) {
    console.error("Failed to toggle window maximize state", error);
  }
};

export const closeDesktopWindow = async (): Promise<void> => {
  if (!isTauri()) {
    return;
  }

  try {
    await getCurrentWindow().close();
  } catch (error) {
    console.error("Failed to close window", error);
  }
};
