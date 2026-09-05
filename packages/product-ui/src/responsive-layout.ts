import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    [query],
  );
  const snapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Keep the composer inside the visible area when a mobile keyboard reduces it. */
export function useProductViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Preserve browser pinch zoom rather than resizing the layout under it.
        if (Math.abs(viewport.scale - 1) < 0.01) {
          ref.current?.style.setProperty(
            "--m-viewport-height",
            `${viewport.height}px`,
          );
        }
      });
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
    };
  }, []);
  return ref;
}
