import { cloudId, type CloudActor } from "../../lib/cloud-contract";
import {
  projectStatusDeleteSchema,
  projectStatusInputSchema,
  projectStatusUpdateSchema,
} from "../../lib/cloud-project-status-contract";
import { CloudError } from "./access";
import { readBody } from "./request-body";
import type { CloudRuntime } from "./runtime";

export async function handleProjectStatusApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const path = new URL(request.url).pathname
    .slice("/api/v1/project-statuses".length)
    .split("/")
    .filter(Boolean);
  const statuses = runtime.projectStatuses;
  if (request.method === "GET" && !path.length)
    return Response.json({ statuses: await statuses.list(actor) });
  if (request.method === "POST" && !path.length)
    return Response.json(
      await statuses.create(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        await readBody(request, projectStatusInputSchema),
      ),
      { status: 201 },
    );
  if (path.length === 1) {
    const id = cloudId.parse(path[0]);
    if (request.method === "PATCH")
      return Response.json({
        status: await statuses.update(
          actor,
          id,
          await readBody(request, projectStatusUpdateSchema),
        ),
      });
    if (request.method === "DELETE") {
      const { replacementId } = await readBody(
        request,
        projectStatusDeleteSchema,
      );
      await statuses.remove(actor, id, replacementId);
      return Response.json({ ok: true });
    }
  }
  throw new CloudError(
    404,
    "not_found",
    "This project status endpoint does not exist.",
  );
}
