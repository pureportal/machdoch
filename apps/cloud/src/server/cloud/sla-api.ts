import { cloudId, type CloudActor } from "../../lib/cloud-contract";
import {
  slaPolicyInputSchema,
  slaPolicyUpdateSchema,
} from "../../lib/issue-sla";
import { CloudError } from "./access";
import { readBody } from "./request-body";
import type { CloudRuntime } from "./runtime";

export async function handleSlaApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const path = new URL(request.url).pathname
    .slice("/api/v1/slas".length)
    .split("/")
    .filter(Boolean);
  const slas = runtime.slas.service;
  if (request.method === "GET" && !path.length)
    return Response.json({ policies: await slas.list(actor) });
  if (request.method === "POST" && !path.length)
    return Response.json(
      await slas.create(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        await readBody(request, slaPolicyInputSchema),
      ),
      { status: 201 },
    );
  if (path.length === 1) {
    const id = cloudId.parse(path[0]);
    if (request.method === "PATCH")
      return Response.json({
        policy: await slas.update(
          actor,
          id,
          (await readBody(request, slaPolicyUpdateSchema)).hours,
        ),
      });
    if (request.method === "DELETE") {
      await slas.remove(actor, id);
      return Response.json({ ok: true });
    }
  }
  throw new CloudError(404, "not_found", "This SLA endpoint does not exist.");
}
