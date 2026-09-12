export const startAutomaticWorkPump = (
  process: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs = 1_000,
): { wake: () => void; stop: () => void } => {
  let stopped = false;
  let running = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = (): void => {
    if (stopped) return;
    if (running) {
      requested = true;
      return;
    }
    clearTimeout(timer);
    running = true;
    void process()
      .catch(onError)
      .finally(() => {
        running = false;
        if (stopped) return;
        const delay = requested ? 0 : intervalMs;
        requested = false;
        timer = setTimeout(wake, delay);
      });
  };
  wake();
  return {
    wake,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
