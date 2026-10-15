import { useEffect } from "react";

export const useMediaModelLibraryRefresh = (
  refreshCatalog: () => Promise<unknown>,
  refreshDiscovery: () => Promise<void>,
): void => {
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState === "hidden")
        return;
      refreshing = true;
      try {
        await Promise.all([refreshCatalog(), refreshDiscovery()]);
      } finally {
        refreshing = false;
      }
    };
    const onFocus = () => void refresh();
    const interval = window.setInterval(onFocus, 5_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshCatalog, refreshDiscovery]);
};
