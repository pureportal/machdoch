import { useCallback, type MouseEvent } from "react";
import {
  closeDesktopWindow,
  minimizeDesktopWindow,
  stopTitlebarEvent,
  toggleDesktopWindowMaximize,
} from "./session-window-controls";

export interface SessionWindowControls {
  onMinimizeWindow: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggleMaximizeWindow: (event: MouseEvent<HTMLButtonElement>) => void;
  onCloseWindow: (event: MouseEvent<HTMLButtonElement>) => void;
}

export const useSessionWindowControls = (): SessionWindowControls => {
  const onMinimizeWindow = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      stopTitlebarEvent(event);
      void minimizeDesktopWindow();
    },
    [],
  );

  const onToggleMaximizeWindow = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      stopTitlebarEvent(event);
      void toggleDesktopWindowMaximize();
    },
    [],
  );

  const onCloseWindow = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      stopTitlebarEvent(event);
      void closeDesktopWindow();
    },
    [],
  );

  return {
    onMinimizeWindow,
    onToggleMaximizeWindow,
    onCloseWindow,
  };
};
