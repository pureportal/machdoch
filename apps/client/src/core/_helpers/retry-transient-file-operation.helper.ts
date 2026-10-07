const TRANSIENT_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "EPERM",
]);

export const retryTransientFileOperation = async <T>(
  operation: () => Promise<T>,
  retryWindowMs = 5_000,
): Promise<T> => {
  const deadline = Date.now() + Math.max(0, retryWindowMs);
  let retryDelayMs = 20;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        typeof error.code !== "string" ||
        !TRANSIENT_FILE_ERROR_CODES.has(error.code) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(retryDelayMs, Math.max(0, deadline - Date.now())),
        ),
      );
      retryDelayMs = Math.min(250, retryDelayMs * 2);
    }
  }
};
