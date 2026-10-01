export const awaitSpeechOperation = <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) {
    return operation;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
};
