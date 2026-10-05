import { api, jsonBody } from "@machdoch/product-ui/fleet-api";

interface FleetTaskTarget {
  instanceId: string;
  displayName: string;
  taskId: string;
}

export async function cancelFleetTasks(
  targets: FleetTaskTarget[],
): Promise<Array<{ key: string; error: string | null }>> {
  const requests = targets.map((target) => ({
    ...target,
    commandId: crypto.randomUUID(),
  }));
  const results = new Array<{ key: string; error: string | null }>(
    requests.length,
  );
  let cursor = 0;
  const cancel = async (): Promise<void> => {
    while (cursor < requests.length) {
      const index = cursor++;
      const target = requests[index]!;
      const key = `${target.instanceId}/${target.taskId}`;
      try {
        await api(
          `/api/instances/${encodeURIComponent(target.instanceId)}/product/commands`,
          {
            method: "POST",
            body: jsonBody({
              kind: "cancel",
              taskId: target.taskId,
              commandId: target.commandId,
            }),
          },
        );
        results[index] = { key, error: null };
      } catch (reason) {
        results[index] = {
          key,
          error: `${target.displayName}: ${reason instanceof Error ? reason.message : "Task could not be stopped."}`,
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, requests.length) }, cancel),
  );
  return results;
}
