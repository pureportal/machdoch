import { z } from "zod";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  automationInputSchema,
  automationRunInputSchema,
  automationStateSchema,
  automationUpdateSchema,
  maximumWebhookPayloadBytes,
} from "../../../lib/cloud-automation-contract";
import { CloudError } from "../access";
import { readBody, readRawBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

const listQuerySchema = z.strictObject({ teamId: cloudId.optional() });
const runsQuerySchema = z.strictObject({
  automationId: cloudId.optional(),
  issueId: cloudId.optional(),
});
const manualQuerySchema = z.strictObject({ issueId: cloudId });
const webhookTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Webhook is unavailable.");

export async function handleAutomationWebhook(
  runtime: CloudRuntime,
  request: Request,
  token: string,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const body = request.body
    ? await readRawBody(request, maximumWebhookPayloadBytes)
    : Buffer.alloc(0);
  let payload: unknown = {};
  if (body.length)
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new CloudError(
        400,
        "invalid_json",
        "Send the webhook payload as JSON.",
      );
    }
  return Response.json(
    await runtime.automations.service.receiveWebhook(
      webhookTokenSchema.parse(token),
      payload,
    ),
    { status: 202 },
  );
}

export async function handleAutomationApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname
    .slice("/api/v1/automations".length)
    .split("/")
    .filter(Boolean);
  const method = request.method;
  const query = Object.fromEntries(url.searchParams);
  const service = runtime.automations.service;
  if (method === "GET" && !parts.length)
    return Response.json(
      await service.list(actor, listQuerySchema.parse(query)),
    );
  if (method === "GET" && parts[0] === "runs" && parts.length === 1)
    return Response.json(
      await service.runs(actor, runsQuerySchema.parse(query)),
    );
  if (method === "GET" && parts[0] === "manual" && parts.length === 1)
    return Response.json(
      await service.forIssue(actor, manualQuerySchema.parse(query).issueId),
    );
  if (method === "GET" && parts.length === 1)
    return Response.json(await service.get(actor, cloudId.parse(parts[0])));
  if (method === "DELETE" && parts.length === 1) {
    await service.remove(actor, cloudId.parse(parts[0]));
    return Response.json({ ok: true });
  }
  if (method === "POST" && parts.length === 2 && parts[1] === "webhook")
    return Response.json(
      await service.rotateWebhook(actor, cloudId.parse(parts[0])),
    );
  const key = cloudId.parse(request.headers.get("idempotency-key"));
  if (method === "POST" && !parts.length)
    return Response.json(
      await service.create(
        actor,
        key,
        await readBody(request, automationInputSchema),
      ),
    );
  if (method === "PATCH" && parts.length === 1)
    return Response.json(
      await service.update(
        actor,
        key,
        cloudId.parse(parts[0]),
        await readBody(request, automationUpdateSchema),
      ),
    );
  if (method === "POST" && parts.length === 2 && parts[1] === "state")
    return Response.json(
      await service.setEnabled(
        actor,
        key,
        cloudId.parse(parts[0]),
        await readBody(request, automationStateSchema),
      ),
    );
  if (method === "POST" && parts.length === 2 && parts[1] === "run")
    return Response.json(
      await service.run(
        actor,
        key,
        cloudId.parse(parts[0]),
        await readBody(request, automationRunInputSchema),
      ),
    );
  throw new CloudError(404, "not_found", "Automation action is unavailable.");
}
