import { useEffect, useRef, useSyncExternalStore } from "react";
import { appControl, type AppControlView } from "./app-control-registry";

export const APP_CONTROL_LEVEL = { app: 0, view: 1, detail: 2 } as const;

export function useAppControlView(
  id: string,
  level: number,
  view: AppControlView | null,
): void {
  const viewRef = useRef(view);
  viewRef.current = view;
  const enabled = view !== null;
  useEffect(() => {
    if (!enabled) return;
    return appControl.register(id, level, () => {
      const current = viewRef.current;
      if (!current) throw new Error(`The ${id} view is closed.`);
      return current;
    });
  }, [enabled, id, level]);
  const locationKey = view?.location.join("\u0000") ?? "";
  const workspaceRoot = view?.workspaceRoot ?? null;
  useEffect(() => {
    if (enabled) appControl.notify();
  }, [enabled, locationKey, workspaceRoot]);
}

export function useAppControlLocation(): string[] {
  const revision = useSyncExternalStore(
    appControl.subscribe,
    appControl.getRevision,
    appControl.getRevision,
  );
  const cache = useRef<{ revision: number; location: string[] } | null>(null);
  if (cache.current?.revision !== revision) {
    const location = appControl.location();
    cache.current = {
      revision,
      location:
        cache.current &&
        cache.current.location.join("\u0000") === location.join("\u0000")
          ? cache.current.location
          : location,
    };
  }
  return cache.current.location;
}
