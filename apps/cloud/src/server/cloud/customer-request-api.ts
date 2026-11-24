import { z } from "zod";
import { cloudId, type CloudActor } from "../../lib/cloud-contract";
import { maximumWebhookPayloadBytes } from "../../lib/cloud-automation-contract";
import {
  customerInputSchema,
  customerRequestUpdateSchema,
  requestChannels,
  requestChannelUpdateSchema,
  requestIntakeUpdateSchema,
} from "../../lib/cloud-customer-request-contract";
import { CloudError } from "./access";
import { readBody, readRawBody } from "./request-body";
import type { CloudRuntime } from "./runtime";

const channelSchema = z.enum(requestChannels);
const secretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Channel is unavailable.");

export function isCustomerRequestIntakeRoute(path: string[]): boolean {
  return (
    path[0] === "customer-requests" && path[1] === "intake" && path.length === 5
  );
}

export async function handleCustomerRequestIntake(
  runtime: CloudRuntime,
  request: Request,
  path: string[],
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
      throw new CloudError(400, "invalid_json", "Send the request as JSON.");
    }
  const result = await runtime.customerRequests.receive(
    cloudId.parse(path[2]),
    channelSchema.parse(path[3]),
    secretSchema.parse(path[4]),
    payload,
  );
  return Response.json(result, { status: result.created ? 201 : 200 });
}

export async function handleCustomerRequestApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  path: string[],
): Promise<Response> {
  const requests = runtime.customerRequests;
  const method = request.method;
  if (path[0] === "customers") {
    if (method === "GET" && path.length === 1)
      return Response.json({ customers: await requests.customers(actor) });
    if (method === "POST" && path.length === 1)
      return Response.json(
        await requests.createCustomer(
          actor,
          await readBody(request, customerInputSchema),
        ),
        { status: 201 },
      );
    if (method === "DELETE" && path.length === 2) {
      await requests.removeCustomer(actor, cloudId.parse(path[1]));
      return Response.json({ ok: true });
    }
  }
  if (path[0] === "customer-requests") {
    if (method === "GET" && path.length === 1)
      return Response.json({
        requests: await requests.forIssue(
          actor,
          cloudId.parse(new URL(request.url).searchParams.get("issueId")),
        ),
      });
    if (path[1] === "settings" && path.length === 2) {
      if (method === "GET")
        return Response.json(await requests.settings(actor));
      if (method === "PUT") {
        await requests.updateSettings(
          actor,
          (await readBody(request, requestIntakeUpdateSchema)).teamId,
        );
        return Response.json(await requests.settings(actor));
      }
    }
    if (path[1] === "channels" && path.length >= 3) {
      const channel = channelSchema.parse(path[2]);
      if (method === "PATCH" && path.length === 3) {
        await requests.setChannelEnabled(
          actor,
          channel,
          (await readBody(request, requestChannelUpdateSchema)).enabled,
        );
        return Response.json({ ok: true });
      }
      if (method === "POST" && path.length === 4 && path[3] === "secret")
        return Response.json(await requests.rotate(actor, channel));
    }
    if (method === "PATCH" && path.length === 2)
      return Response.json(
        await requests.link(
          actor,
          cloudId.parse(path[1]),
          (await readBody(request, customerRequestUpdateSchema)).customerId,
        ),
      );
  }
  throw new CloudError(
    404,
    "not_found",
    "This customer request endpoint does not exist.",
  );
}
