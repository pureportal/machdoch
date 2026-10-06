import {
  commandReceiptSchema,
  productCommandSchema,
  productSnapshotSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import type { ProductRuntime } from "@machdoch/product-ui";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";

export function createInstanceRuntime(
  instanceId: string,
  settingsEnabled: boolean,
  initialSessionId?: string,
): ProductRuntime {
  const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
  const selectionCommandId = crypto.randomUUID();
  let sessionSelected = false;
  let selectionRequested = false;
  const readSnapshot = async (
    signal?: AbortSignal,
  ): Promise<ProductSnapshot> => {
    const payload = await api<unknown>(`${basePath}/snapshot`, { signal });
    const result = productSnapshotSchema.safeParse(payload);
    if (!result.success)
      throw new Error("Instance returned incompatible product data.");
    return result.data;
  };
  const runtime: ProductRuntime = {
    mediaHref: `/media-studio/index.html?instance=${encodeURIComponent(instanceId)}`,
    ralphHref: `/media-studio/ralph.html?instance=${encodeURIComponent(instanceId)}`,
    schedulerHref: `/media-studio/scheduler.html?instance=${encodeURIComponent(instanceId)}`,
    instructionsHref: `/media-studio/instructions.html?instance=${encodeURIComponent(instanceId)}`,
    servicesHref: `/instances/${encodeURIComponent(instanceId)}/runs`,
    ...(settingsEnabled ? { settingsHref: "/settings" } : {}),
    async getSnapshot(signal) {
      const snapshot = await readSnapshot(signal);
      if (!initialSessionId || sessionSelected) return snapshot;
      if (
        !snapshot.shell?.sessions.some(
          (session) => session.id === initialSessionId,
        )
      )
        throw new Error(
          "This session is no longer on the device. Open the device from Overview.",
        );
      if (snapshot.shell.activeSessionId === initialSessionId) {
        sessionSelected = true;
        return snapshot;
      }
      signal?.throwIfAborted();
      const selectionSignal = AbortSignal.any(
        signal
          ? [signal, AbortSignal.timeout(8_000)]
          : [AbortSignal.timeout(8_000)],
      );
      if (!selectionRequested) {
        await runtime.execute(
          {
            kind: "activate-session",
            sessionId: initialSessionId,
            commandId: selectionCommandId,
          },
          selectionSignal,
        );
        selectionRequested = true;
      }
      const confirmationDeadline = Date.now() + 8_000;
      let selectedSnapshot = await readSnapshot(selectionSignal);
      while (selectedSnapshot.shell?.activeSessionId !== initialSessionId) {
        selectionSignal.throwIfAborted();
        if (
          !selectedSnapshot.shell?.sessions.some(
            (session) => session.id === initialSessionId,
          )
        )
          throw new Error(
            "This session is no longer on the device. Open the device from Overview.",
          );
        if (Date.now() >= confirmationDeadline)
          throw new Error(
            "Session could not be selected. Retry or open the device.",
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        selectionSignal.throwIfAborted();
        selectedSnapshot = await readSnapshot(selectionSignal);
      }
      selectionSignal.throwIfAborted();
      sessionSelected = true;
      return selectedSnapshot;
    },
    async execute(command, signal) {
      const validatedCommand = productCommandSchema.parse({
        ...command,
        commandId: command.commandId ?? crypto.randomUUID(),
      });
      const payload = await api<unknown>(`${basePath}/commands`, {
        method: "POST",
        body: jsonBody(validatedCommand),
        signal,
      });
      const result = commandReceiptSchema.safeParse(payload);
      if (
        !result.success ||
        result.data.commandId !== validatedCommand.commandId
      )
        throw new Error("Instance returned an invalid command receipt.");
      return result.data;
    },
  };
  return runtime;
}
