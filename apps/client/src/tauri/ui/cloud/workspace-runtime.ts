import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod/v4";
import {
  cloudWorkspaceReplySchema,
  cloudWorkspaceRequestSchema,
  type CloudWorkspaceRequest,
  type CloudWorkspaceView,
} from "@machdoch/fleet-protocol/cloud-workspaces";

const cloudRunnerViewsSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      phase: z.enum(["running", "stopped", "failed"]),
      message: z.string().max(2400).nullable(),
      lastTask: z.string().max(2400).nullable(),
    }),
  )
  .max(100);
export type CloudRunnerView = z.infer<typeof cloudRunnerViewsSchema>[number];

function requireDesktop(): void {
  if (!isTauri())
    throw new Error(
      "Manage workspace connections in the Machdoch desktop app.",
    );
}

export async function manageCloudWorkspaces(
  request: CloudWorkspaceRequest,
): Promise<CloudWorkspaceView[]> {
  requireDesktop();
  const response = cloudWorkspaceReplySchema.parse(
    await invoke("cloud_workspace_request", {
      request: cloudWorkspaceRequestSchema.parse(request),
    }),
  );
  if (!response.ok) throw new Error(response.error);
  return response.connections;
}

export async function manageCloudRunners(
  request: { action: "list" } | { action: "start" | "stop"; id: string },
): Promise<CloudRunnerView[]> {
  requireDesktop();
  return cloudRunnerViewsSchema.parse(
    await invoke(
      `cloud_runner_${request.action}`,
      request.action === "list" ? {} : { id: z.uuid().parse(request.id) },
    ),
  );
}
