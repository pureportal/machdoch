import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  allowedRepositoriesSchema,
  mcpConnectorInputSchema,
} from "../../../lib/agent-personalization";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handleAgentPersonalizationApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const path = new URL(request.url).pathname
    .slice("/api/v1/".length)
    .split("/");
  const personalization = runtime.chat.personalization;
  if (request.method === "GET" && path.length === 1)
    return Response.json(await personalization.get(actor));
  const key = cloudId.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    throw new CloudError(
      400,
      "command_key_required",
      "Provide a UUID Idempotency-Key for this change.",
    );
  if (
    request.method === "POST" &&
    path.length === 2 &&
    path[1] === "connectors"
  )
    return Response.json(
      await personalization.addConnector(
        actor,
        key.data,
        await readBody(request, mcpConnectorInputSchema),
      ),
      { status: 201 },
    );
  if (
    request.method === "POST" &&
    path.length === 4 &&
    path[1] === "connectors" &&
    path[3] === "remove"
  )
    return Response.json(
      await personalization.removeConnector(
        actor,
        key.data,
        cloudId.parse(path[2]),
      ),
    );
  if (
    request.method === "PUT" &&
    path.length === 2 &&
    path[1] === "repositories"
  )
    return Response.json(
      await personalization.setRepositories(
        actor,
        key.data,
        (await readBody(request, allowedRepositoriesSchema)).repositoryIds,
      ),
    );
  throw new CloudError(
    404,
    "not_found",
    "This agent personalization endpoint does not exist.",
  );
}
