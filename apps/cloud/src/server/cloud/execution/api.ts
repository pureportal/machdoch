import { z } from "zod";
import {
  workerArtifactInputSchema,
  workerArtifactChunkSchema,
  workerArtifactIdentitySchema,
} from "../../../lib/cloud-artifact-contract";
import { workerRepositorySchema } from "../../../lib/cloud-repository-contract";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  attemptIdentitySchema,
  executionProfileInputSchema,
  executionProfileUpdateSchema,
  runCancelSchema,
  runInputSchema,
  workerAcceptSchema,
  workerClaimSchema,
  workerFinishSchema,
  workerInputSchema,
  workerActivitySchema,
  workerProgressSchema,
  clientWorkspaceBindingSchema,
} from "@machdoch/fleet-protocol/cloud-execution";
import { bearerToken } from "../../request-auth";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import {
  taskInferenceInputSchema,
  maximumTaskInferenceRequestBytes,
  taskInferenceReadSchema,
} from "@machdoch/fleet-protocol/cloud-inference";

export async function handleRunnerApi(
  runtime: CloudRuntime,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST")
    throw new CloudError(
      405,
      "method_not_allowed",
      "Runner commands require POST.",
    );
  if (request.headers.has("origin") || request.headers.has("cookie"))
    throw new CloudError(
      403,
      "runner_transport",
      "Use a runner connection without browser credentials.",
    );
  const token = bearerToken(request);
  if (!token)
    throw new CloudError(
      401,
      "runner_authentication",
      "Runner credentials are required.",
    );
  const endpoint = new URL(request.url).pathname;
  const leases = runtime.execution.leases;
  if (endpoint === "/api/v1/runner/registration") {
    await readBody(request, z.strictObject({}));
    return Response.json(
      await runtime.execution.clientWorkspaces.registration(token),
    );
  }
  if (endpoint === "/api/v1/runner/workspace")
    return Response.json(
      await runtime.execution.clientWorkspaces.bind(
        token,
        await readBody(request, clientWorkspaceBindingSchema),
      ),
    );
  if (endpoint === "/api/v1/runner/disconnect") {
    await readBody(request, z.strictObject({}));
    return Response.json(
      await runtime.execution.clientWorkspaces.disconnect(token),
    );
  }
  if (endpoint === "/api/v1/runner/availability") {
    await readBody(request, z.strictObject({}));
    return Response.json(await leases.available(token));
  }
  if (endpoint === "/api/v1/runner/recovery") {
    const input = await readBody(request, workerClaimSchema);
    return Response.json(await leases.recover(token, input.claimId));
  }
  if (endpoint === "/api/v1/runner/artifacts/begin")
    return Response.json(
      await runtime.execution.uploads.begin(
        token,
        await readBody(request, workerArtifactInputSchema),
      ),
    );
  if (endpoint === "/api/v1/runner/artifacts/chunk")
    return Response.json(
      await runtime.execution.uploads.write(
        token,
        await readBody(request, workerArtifactChunkSchema),
      ),
    );
  if (endpoint === "/api/v1/runner/artifacts/complete")
    return Response.json(
      await runtime.execution.uploads.complete(
        token,
        await readBody(request, workerArtifactIdentitySchema),
      ),
    );
  if (endpoint === "/api/v1/runner/artifacts/abandon")
    return Response.json(
      await runtime.execution.uploads.abandon(
        token,
        await readBody(request, workerArtifactIdentitySchema),
      ),
    );
  if (endpoint === "/api/v1/runner/repository")
    return runtime.execution.repositories.transfer(
      token,
      await readBody(request, workerRepositorySchema),
      request.signal,
    );
  if (endpoint === "/api/v1/runner/inference") {
    const result = await runtime.execution.inference.submit(
      token,
      await readBody(
        request,
        taskInferenceInputSchema,
        maximumTaskInferenceRequestBytes,
      ),
    );
    runtime.inference.worker.wake();
    return Response.json(result);
  }
  if (endpoint === "/api/v1/runner/inference/result")
    return Response.json(
      await runtime.execution.inference.get(
        token,
        await readBody(request, taskInferenceReadSchema),
      ),
    );
  if (endpoint === "/api/v1/runner/claims") {
    const input = await readBody(request, workerClaimSchema);
    return Response.json(await leases.claim(token, input.claimId));
  }
  if (endpoint === "/api/v1/runner/accept")
    return Response.json(
      await leases.accept(token, await readBody(request, workerAcceptSchema)),
    );
  if (endpoint === "/api/v1/runner/heartbeat")
    return Response.json(
      await leases.heartbeat(
        token,
        await readBody(request, attemptIdentitySchema),
      ),
    );
  if (endpoint === "/api/v1/runner/progress")
    return Response.json(
      await leases.progress(
        token,
        await readBody(request, workerProgressSchema),
      ),
    );
  if (endpoint === "/api/v1/runner/activity")
    return Response.json(
      await leases.activity(
        token,
        await readBody(request, workerActivitySchema),
      ),
    );
  if (endpoint === "/api/v1/runner/finish")
    return Response.json(
      await leases.finish(token, await readBody(request, workerFinishSchema)),
    );
  throw new CloudError(404, "not_found", "Runner endpoint does not exist.");
}

export async function handleExecutionApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/v1/".length).split("/");
  const method = request.method;
  if (method === "GET") {
    if (path[0] === "runs" && path[2] === "artifacts" && path.length === 4)
      return runtime.execution.artifacts.download(
        actor,
        cloudId.parse(path[1]),
        cloudId.parse(path[3]),
        request.signal,
      );
    if (
      path[0] === "runs" &&
      path[2] === "artifacts" &&
      path[4] === "preview" &&
      path.length === 5
    )
      return Response.json(
        await runtime.execution.artifacts.preview(
          actor,
          cloudId.parse(path[1]),
          cloudId.parse(path[3]),
        ),
      );
    if (path[0] === "execution-profiles" && path.length === 1)
      return Response.json({
        profiles: await runtime.execution.profiles.list(
          actor,
          cloudId
            .optional()
            .parse(url.searchParams.get("projectId") ?? undefined),
        ),
      });
    if (path[0] === "execution-workers" && path.length === 1)
      return Response.json({
        workers: await runtime.execution.workers.list(
          actor,
          cloudId.parse(url.searchParams.get("profileId")),
        ),
      });
    if (path[0] === "runs" && path.length === 1)
      return Response.json({
        runs: await runtime.execution.runs.list(
          actor,
          cloudId
            .optional()
            .parse(url.searchParams.get("issueId") ?? undefined),
        ),
      });
    if (path[0] === "runs" && path.length === 2)
      return Response.json(
        await runtime.execution.runs.get(actor, cloudId.parse(path[1])),
      );
  }
  if (
    method === "POST" &&
    path[0] === "execution-workers" &&
    path.length === 1
  ) {
    const input = await readBody(request, workerInputSchema);
    return Response.json(
      await runtime.execution.workers.register(
        actor,
        input.profileId,
        input.name,
      ),
      { status: 201 },
    );
  }
  if (
    method === "POST" &&
    path[0] === "execution-workers" &&
    path.length === 3 &&
    path[2] === "rotate"
  ) {
    await readBody(request, z.strictObject({}));
    return Response.json(
      await runtime.execution.workers.rotate(actor, cloudId.parse(path[1])),
    );
  }
  if (!["POST", "PATCH"].includes(method))
    throw new CloudError(
      405,
      "method_not_allowed",
      "This method is not supported.",
    );
  const key = cloudId.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    throw new CloudError(
      400,
      "command_key_required",
      "Provide a UUID Idempotency-Key for this change.",
    );
  if (
    path[0] === "execution-profiles" &&
    path.length === 1 &&
    method === "POST"
  )
    return Response.json(
      await runtime.execution.profiles.create(
        actor,
        key.data,
        await readBody(request, executionProfileInputSchema),
      ),
      { status: 201 },
    );
  if (
    path[0] === "execution-profiles" &&
    path.length === 2 &&
    method === "PATCH"
  )
    return Response.json(
      await runtime.execution.profiles.update(
        actor,
        key.data,
        cloudId.parse(path[1]),
        await readBody(request, executionProfileUpdateSchema),
      ),
    );
  if (path[0] === "runs" && path.length === 1 && method === "POST")
    return Response.json(
      await runtime.execution.runs.create(
        actor,
        key.data,
        await readBody(request, runInputSchema),
      ),
      { status: 201 },
    );
  if (
    path[0] === "runs" &&
    path.length === 3 &&
    path[2] === "cancel" &&
    method === "POST"
  ) {
    const input = await readBody(request, runCancelSchema);
    return Response.json(
      await runtime.execution.runs.cancel(
        actor,
        key.data,
        cloudId.parse(path[1]),
        input.revision,
      ),
    );
  }
  if (
    path[0] === "execution-workers" &&
    path.length === 3 &&
    path[2] === "revoke" &&
    method === "POST"
  ) {
    await readBody(request, z.strictObject({}));
    return Response.json(
      await runtime.execution.workers.revoke(
        actor,
        key.data,
        cloudId.parse(path[1]),
      ),
    );
  }
  throw new CloudError(404, "not_found", "Execution endpoint does not exist.");
}
