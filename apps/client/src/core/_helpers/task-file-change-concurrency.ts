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
    Math.max(1, Math.floor(concurrencyLimit)),
  );
  const pendingValues = values.entries();

  const runWorker = async (): Promise<void> => {
    while (true) {
      const nextValue = pendingValues.next();

      if (nextValue.done) {
        return;
      }

      const [index, value] = nextValue.value;
      results[index] = await mapper(value, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
};
