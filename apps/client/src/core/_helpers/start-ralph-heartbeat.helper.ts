export const startRalphHeartbeat = (
  refresh: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): (() => Promise<void>) => {
  let pending = Promise.resolve();
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    pending = Promise.resolve()
      .then(refresh)
      .catch(onError)
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
  };
};
