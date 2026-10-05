"use client";

import { RemoteProductApp } from "@machdoch/product-ui";
import { useMemo } from "react";
import { createInstanceRuntime } from "@/lib/instance-runtime";

export function InstanceProduct({
  instanceId,
  instanceName,
  settingsEnabled,
  initialSessionId,
}: {
  instanceId: string;
  instanceName: string;
  settingsEnabled: boolean;
  initialSessionId?: string;
}): React.ReactElement {
  const runtime = useMemo(
    () => createInstanceRuntime(instanceId, settingsEnabled, initialSessionId),
    [instanceId, settingsEnabled, initialSessionId],
  );

  return (
    <RemoteProductApp
      instanceName={instanceName}
      runtime={runtime}
      {...(initialSessionId ? { initialView: "chat" } : {})}
    />
  );
}
