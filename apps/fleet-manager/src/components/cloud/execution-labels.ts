import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";

export const executionTargetLabels: Record<ExecutionProfile["target"], string> =
  {
    cloud: "Cloud (Linux)",
    "client-linux": "Client (Linux)",
    client: "Client (native)",
  };
