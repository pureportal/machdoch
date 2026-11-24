const WORKER_DIAGNOSTICS_MARKER = "\nWorker diagnostics (tail):";

export const workerFailureSummary = (error: string): string =>
  error.split(WORKER_DIAGNOSTICS_MARKER, 1)[0].trim();
