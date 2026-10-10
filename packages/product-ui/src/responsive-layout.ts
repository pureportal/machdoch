import { useCallback, useEffect, useSyncExternalStore } from "react";

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

export function useProductViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const properties = ["--m-viewport-height", "--m-viewport-offset-top"];
    const previous = properties.map((name) =>
      root.style.getPropertyValue(name),
    );
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Math.abs(viewport.scale - 1) < 0.01) {
          root.style.setProperty("--m-viewport-height", `${viewport.height}px`);
          root.style.setProperty(
            "--m-viewport-offset-top",
            `${viewport.offsetTop}px`,
          );
        }
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      properties.forEach((name, index) => {
        if (previous[index]) root.style.setProperty(name, previous[index]);
        else root.style.removeProperty(name);
      });
    };
  }, []);
}
