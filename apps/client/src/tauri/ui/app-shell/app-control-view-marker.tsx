import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";

export function AppControlViewMarker({ id }: { id: string }): null {
  useAppControlView(id, APP_CONTROL_LEVEL.view, { location: [] });
  return null;
}
