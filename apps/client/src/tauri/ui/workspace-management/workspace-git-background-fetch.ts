export interface BackgroundFetchOptions {
  intervalMs: number;
  maxBackoffMs: number;
  fetch: (repositoryRoot: string) => Promise<void>;
  online: () => boolean;
  visible: () => boolean;
  now: () => number;
  setTimer: (task: () => void, delayMs: number) => () => void;
}

interface ScheduledRepository {
  repositoryRoot: string;
  failures: number;
  nextAt: number;
  running: boolean;
  cancel: (() => void) | null;
  watchers: number;
}

export interface BackgroundFetchScheduler {
  watch: (repositoryRoot: string) => () => void;
  fetched: (repositoryRoot: string) => void;
  nextFetchAt: (repositoryRoot: string) => number | undefined;
}

export const backgroundFetchDelay = (
  intervalMs: number,
  maxBackoffMs: number,
  failures: number,
): number =>
  failures === 0
    ? intervalMs
    : Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 16));

export const createBackgroundFetchScheduler = ({
  intervalMs,
  maxBackoffMs,
  fetch,
  online,
  visible,
  now,
  setTimer,
}: BackgroundFetchOptions): BackgroundFetchScheduler => {
  const repositories = new Map<string, ScheduledRepository>();

  const arm = (repository: ScheduledRepository): void => {
    repository.cancel?.();
    repository.cancel = setTimer(
      () => void run(repository),
      Math.max(0, repository.nextAt - now()),
    );
  };

  const run = async (repository: ScheduledRepository): Promise<void> => {
    repository.cancel = null;
    if (repository.watchers === 0 || repository.running) return;
    if (!online() || !visible()) {
      repository.nextAt = now() + intervalMs;
      arm(repository);
      return;
    }
    repository.running = true;
    try {
      await fetch(repository.repositoryRoot);
      repository.failures = 0;
    } catch {
      repository.failures += 1;
    } finally {
      repository.running = false;
    }
    if (repository.watchers === 0) return;
    repository.nextAt =
      now() +
      backgroundFetchDelay(intervalMs, maxBackoffMs, repository.failures);
    arm(repository);
  };

  return {
    watch: (repositoryRoot) => {
      let repository = repositories.get(repositoryRoot);
      if (!repository) {
        repository = {
          repositoryRoot,
          failures: 0,
          nextAt: now() + intervalMs,
          running: false,
          cancel: null,
          watchers: 0,
        };
        repositories.set(repositoryRoot, repository);
        arm(repository);
      }
      repository.watchers += 1;
      let watching = true;
      return () => {
        if (!watching || !repository) return;
        watching = false;
        repository.watchers -= 1;
        if (repository.watchers > 0) return;
        repository.cancel?.();
        repositories.delete(repositoryRoot);
      };
    },
    fetched: (repositoryRoot) => {
      const repository = repositories.get(repositoryRoot);
      if (!repository) return;
      repository.failures = 0;
      repository.nextAt = now() + intervalMs;
      arm(repository);
    },
    nextFetchAt: (repositoryRoot) => repositories.get(repositoryRoot)?.nextAt,
  };
};
