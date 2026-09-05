"use client";

import {
  commandReceiptSchema,
  productCommandSchema,
  productSnapshotSchema,
  type ProductCommand,
} from "@machdoch/fleet-protocol";
import { RemoteProductApp, type ProductRuntime } from "@machdoch/product-ui";
import { useMemo } from "react";
import { api, jsonBody } from "@/lib/api";

export function InstanceProduct({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}): React.ReactElement {
  const runtime = useMemo<ProductRuntime>(() => {
    const basePath = `/api/instances/${encodeURIComponent(instanceId)}/product`;
    return {
      servicesHref: `/instances/${encodeURIComponent(instanceId)}/runs`,
      async getSnapshot(signal) {
        const payload = await api<unknown>(`${basePath}/snapshot`, { signal });
        const result = productSnapshotSchema.safeParse(payload);
        if (!result.success) {
          throw new Error("Instance returned incompatible product data.");
        }
        return result.data;
      },
      async execute(command: ProductCommand, signal?: AbortSignal) {
        const validatedCommand = productCommandSchema.parse(command);
        const payload = await api<unknown>(`${basePath}/commands`, {
          method: "POST",
          body: jsonBody(validatedCommand),
          signal,
        });
        const result = commandReceiptSchema.safeParse(payload);
        if (!result.success) {
          throw new Error("Instance returned an invalid command receipt.");
        }
        return result.data;
      },
    };
  }, [instanceId]);

  return <RemoteProductApp instanceName={instanceName} runtime={runtime} />;
}
