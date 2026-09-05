/** Each job owns its worker; cancellation and timeouts release its CPU and memory. */
export const runFilePreviewWorkerJob = <T>(
  createWorker: () => Worker,
  request: unknown,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (error) {
      reject(error);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let ready = false;
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const abort = () =>
      finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    // Allow cold worker script loading independently of the computation budget.
    timer = setTimeout(
      () => finish(new Error("File preview processing could not start.")),
      5_000,
    );
    worker.onmessage = (
      event: MessageEvent<{ ready?: boolean; value?: T; error?: string }>,
    ) => {
      if (event.data.ready && !ready) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
        try {
          worker.postMessage(request);
        } catch (error) {
          finish(error);
        }
      } else if (ready && !event.data.ready) {
        finish(
          event.data.error ? new Error(event.data.error) : undefined,
          event.data.value,
        );
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error("File preview processing failed."));
    };
    worker.onmessageerror = () =>
      finish(
        new Error("File preview processing returned an unreadable result."),
      );
    if (signal.aborted) abort();
  });
