import { listMcpAppsForRun } from "./apps.js";

export function observeMcpApps(
  root: string,
  runId: string,
  onResult: (id: string) => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  const seen = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const read = async (): Promise<void> => {
    for (const id of await listMcpAppsForRun(root, runId)) {
      if (seen.has(id)) continue;
      await onResult(id);
      seen.add(id);
    }
  };
  const poll = (): void => {
    pending = read()
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(poll, 1000);
      });
  };
  poll();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    await read().catch(onError);
  };
}
