const cancellers = new WeakMap<AbortSignal, (reason: string) => void>();

/** Lets code that only holds a run's signal ask the run itself to stop. */
export const registerRunCancellation = (
  signal: AbortSignal,
  cancel: (reason: string) => void,
): void => {
  cancellers.set(signal, cancel);
};

/** Cancels the run that owns `signal`. Returns false when no run claims it. */
export const requestRunCancellation = (
  signal: AbortSignal | undefined,
  reason: string,
): boolean => {
  const cancel = signal ? cancellers.get(signal) : undefined;
  if (!cancel || signal?.aborted) return false;
  cancel(reason);
  return true;
};

/** Lets a signal derived from a run's signal (for example with `AbortSignal.any`) cancel that run too. */
export const linkRunCancellation = (
  derived: AbortSignal,
  parent: AbortSignal | undefined,
): void => {
  const cancel = parent ? cancellers.get(parent) : undefined;
  if (cancel) cancellers.set(derived, cancel);
};
