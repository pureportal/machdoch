export interface WorkspaceOperationLock {
  pending: boolean;
}

export const startExclusiveWorkspaceOperation = <Result>(
  lock: WorkspaceOperationLock,
  operation: () => Result | PromiseLike<Result>,
): Promise<Result> | null => {
  if (lock.pending) return null;
  lock.pending = true;

  let result: Result | PromiseLike<Result>;
  try {
    result = operation();
  } catch (error) {
    lock.pending = false;
    throw error;
  }

  return Promise.resolve(result).finally(() => {
    lock.pending = false;
  });
};
