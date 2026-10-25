import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  cloudWorkspaceReplySchema,
  cloudWorkspaceRequestSchema,
  type CloudWorkspaceRequest,
  type CloudWorkspaceView,
} from "@machdoch/fleet-protocol/cloud-workspaces";

export async function manageCloudWorkspaces(
  request: CloudWorkspaceRequest,
): Promise<CloudWorkspaceView[]> {
  if (!isTauri())
    throw new Error(
      "Manage workspace connections in the Machdoch desktop app.",
    );
  const response = cloudWorkspaceReplySchema.parse(
    await invoke("cloud_workspace_request", {
      request: cloudWorkspaceRequestSchema.parse(request),
    }),
  );
  if (!response.ok) throw new Error(response.error);
  return response.connections;
}
