import {
  RunnerConnection,
  RunnerRequestError,
  isTransientRunnerError,
} from "@machdoch/cloud-client";
import {
  cloudWorkspaceRequestSchema,
  cloudWorkspaceReplySchema,
  type CloudWorkspaceRequest,
  type CloudWorkspaceReply,
  type CloudWorkspaceView,
} from "@machdoch/fleet-protocol/cloud-workspaces";
import { ClientCloudBindings } from "./bindings.js";

export async function cloudWorkspaceViews(
  bindings: ClientCloudBindings,
  refresh: boolean,
): Promise<CloudWorkspaceView[]> {
  const connections = await bindings.list();
  const views: CloudWorkspaceView[] = connections.map((connection) => ({
    id: connection.id,
    workspaceId: connection.binding.workspaceId,
    origin: connection.origin,
    workspaceRoot: connection.workspaceRoot,
    workspaceName: connection.binding.name,
    projectName: connection.registration.projectName,
    profileName: connection.registration.profile.name,
    status: connection.status,
    access: "unchecked",
  }));
  if (!refresh) return views;
  const deadline = AbortSignal.timeout(10000);
  let index = 0;
  async function inspect() {
    while (index < views.length) {
      const position = index++;
      const view = views[position]!;
      if (view.status === "disconnected") continue;
      if (deadline.aborted) {
        view.access = "unreachable";
        continue;
      }
      try {
        const connection = await bindings.get(view.id);
        const registration = await new RunnerConnection(
          connection.origin,
          connection.token,
        ).registration(deadline);
        if (
          registration.workerId !== connection.registration.workerId ||
          registration.profile.id !== connection.registration.profile.id ||
          (registration.workspaceBinding &&
            registration.workspaceBinding.workspaceId !==
              connection.binding.workspaceId)
        )
          throw new Error("Cloud identity changed");
        view.access = "available";
        view.projectName = registration.projectName;
        view.profileName = registration.profile.name;
      } catch (error) {
        view.access =
          error instanceof RunnerRequestError && error.status === 401
            ? "credentials_required"
            : error instanceof RunnerRequestError && error.status === 403
              ? "ended"
              : "unreachable";
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, views.length) }, () => inspect()),
  );
  return views;
}

export async function executeCloudWorkspaceRequest(
  input: unknown,
  bindings = new ClientCloudBindings(),
): Promise<CloudWorkspaceReply> {
  let request: CloudWorkspaceRequest;
  try {
    request = cloudWorkspaceRequestSchema.parse(input);
  } catch {
    return {
      ok: false,
      error:
        "The cloud request is invalid. Check the address, workspace and token.",
    };
  }
  try {
    if (request.action === "connect")
      await bindings.connect(
        request.origin,
        request.token,
        request.workspaceRoot,
        request.name,
      );
    if (request.action === "reconnect") {
      const connection = await bindings.get(request.id);
      await bindings.connect(
        connection.origin,
        request.token ?? connection.token,
        connection.workspaceRoot,
        connection.binding.name,
        connection.registration.workerId,
      );
    }
    if (request.action === "disconnect")
      await bindings.disconnect(request.id, request.token);
    return cloudWorkspaceReplySchema.parse({
      ok: true,
      connections: await cloudWorkspaceViews(
        bindings,
        request.action !== "list" || request.refresh,
      ),
    });
  } catch (error) {
    let message = isTransientRunnerError(error)
      ? "The cloud could not be reached. Check the address and connection, then retry."
      : error instanceof RunnerRequestError
        ? ({
            runner_authentication:
              "The runner token is invalid. Enter a current token for this runner.",
            runner_revoked:
              "Runner access has ended. Enter a current token for this runner.",
            repository_mismatch:
              "This workspace belongs to another repository. Choose the matching workspace.",
            workspace_already_linked:
              "This runner is already linked. Enroll a new runner to change its workspace.",
            client_profile_required:
              "Choose a runner enrolled for a client execution profile.",
          }[error.code] ??
          "The cloud rejected the request. Check the runner's execution profile and retry.")
        : error instanceof Error
          ? error.message
          : "The cloud request failed. Retry the action.";
    if ("token" in request && request.token)
      message = message.replaceAll(request.token, "[redacted]");
    return { ok: false, error: message.slice(0, 2000) };
  }
}
