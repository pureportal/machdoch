export const mapWithConcurrencyLimit = async <Input, Output>(
  values: readonly Input[],
  concurrencyLimit: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<Output>(values.length);
  const workerCount = Math.min(
    values.length,
    Number.isNaN(concurrencyLimit)
      ? 1
      : Math.max(1, Math.floor(concurrencyLimit)),
  );
  const pendingValues = values.entries();
  let failed = false;
  let failure: unknown;

  const runWorker = async (): Promise<void> => {
    while (!failed) {
      const nextValue = pendingValues.next();

      if (nextValue.done) {
        return;
      }

      const [index, value] = nextValue.value;
      try {
        results[index] = await mapper(value, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  // Finish active work before the caller releases resources, and never start
  // more work once a worker has failed.
  if (failed) throw failure;
  return results;
};
