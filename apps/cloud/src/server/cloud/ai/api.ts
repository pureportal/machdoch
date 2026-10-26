import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  providerInputSchema,
  providerUpdateSchema,
} from "@machdoch/fleet-protocol/cloud-providers";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handleAiProviderApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/v1/".length).split("/");
  if (request.method === "GET" && path.length === 1)
    return Response.json(
      await runtime.aiProviders.list(
        actor,
        url.searchParams.get("view") === "manage",
      ),
    );
  const key = cloudId.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    throw new CloudError(
      400,
      "command_key_required",
      "Provide a UUID Idempotency-Key for this change.",
    );
  if (request.method === "POST" && path.length === 1)
    return Response.json(
      await runtime.aiProviders.create(
        actor,
        key.data,
        await readBody(request, providerInputSchema),
      ),
      { status: 201 },
    );
  if (request.method === "PATCH" && path.length === 2)
    return Response.json(
      await runtime.aiProviders.update(
        actor,
        key.data,
        cloudId.parse(path[1]),
        await readBody(request, providerUpdateSchema),
      ),
    );
  throw new CloudError(
    404,
    "not_found",
    "This AI provider endpoint does not exist.",
  );
}
