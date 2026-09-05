/** One request at a time, with hidden-window suspension and bounded error backoff. */
export const startActivityPolling = (
  poll: (signal: AbortSignal) => Promise<boolean>,
  intervalMs: (active: boolean) => number,
): { refresh: () => void; stop: () => void } => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let rerun = false;
  let active = false;
  let failures = 0;
  const hidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";
  const refresh = (): void => {
    clearTimeout(timer);
    if (controller.signal.aborted || hidden()) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        active = await poll(controller.signal);
        failures = 0;
      } catch {
        failures++;
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && !hidden()) {
          const delay = rerun
            ? 0
            : Math.min(
                60_000,
                intervalMs(active) *
                  2 ** Math.min(Math.max(0, failures - 1), 5),
              );
          timer = setTimeout(refresh, delay);
        }
        rerun = false;
      }
    })();
  };
  const visibilityChanged = () => {
    if (hidden()) {
      clearTimeout(timer);
      rerun = false;
    } else refresh();
  };
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visibilityChanged);
  refresh();
  return {
    refresh,
    stop: () => {
      controller.abort();
      clearTimeout(timer);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
};
