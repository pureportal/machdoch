import {
  getCurrentWindow,
  type DragDropEvent as TauriDragDropEvent,
} from "@tauri-apps/api/window";

export interface DropPoint {
  x: number;
  y: number;
}

interface DropZoneBounds {
  getBoundingClientRect(): Pick<DOMRect, "left" | "top" | "right" | "bottom">;
}

export interface NativeDropZone {
  element: DropZoneBounds;
  onHover(point: DropPoint | null): void;
  onDrop(paths: string[], point: DropPoint): void;
}

const zones = new Set<NativeDropZone>();
let hovered: NativeDropZone | null = null;
let unsubscribe: Promise<() => void> | null = null;

export const dropPointFromPhysical = (
  position: { x: number; y: number },
  scale: number,
): DropPoint => ({ x: position.x / scale, y: position.y / scale });

export const nativeDropZoneAt = (
  point: DropPoint,
  candidates: Iterable<NativeDropZone> = zones,
): NativeDropZone | null => {
  for (const zone of candidates) {
    const bounds = zone.element.getBoundingClientRect();
    if (
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    ) {
      return zone;
    }
  }
  return null;
};

const hover = (zone: NativeDropZone | null, point: DropPoint | null): void => {
  if (hovered && hovered !== zone) hovered.onHover(null);
  hovered = zone;
  zone?.onHover(point);
};

const handleDragDrop = (payload: TauriDragDropEvent): void => {
  if (payload.type === "leave") {
    hover(null, null);
    return;
  }
  const point = dropPointFromPhysical(
    payload.position,
    window.devicePixelRatio || 1,
  );
  const zone = nativeDropZoneAt(point);
  if (payload.type === "drop") {
    hover(null, null);
    zone?.onDrop(payload.paths, point);
    return;
  }
  hover(zone, point);
};

const subscribe = (): void => {
  unsubscribe = getCurrentWindow().onDragDropEvent((event) => {
    handleDragDrop(event.payload);
  });
  unsubscribe.catch((error: unknown) => {
    console.error("Failed to subscribe to dropped files", error);
  });
};

export const registerNativeDropZone = (zone: NativeDropZone): (() => void) => {
  zones.add(zone);
  if (!unsubscribe) subscribe();
  return () => {
    zones.delete(zone);
    if (hovered === zone) hovered = null;
    if (zones.size === 0 && unsubscribe) {
      const pending = unsubscribe;
      unsubscribe = null;
      void pending
        .then((unlisten) => unlisten())
        .catch((error: unknown) => {
          console.error("Failed to unsubscribe from dropped files", error);
        });
    }
  };
};

export const isOverNativeDropZone = (position: {
  x: number;
  y: number;
}): boolean =>
  nativeDropZoneAt(
    dropPointFromPhysical(position, window.devicePixelRatio || 1),
  ) !== null;
