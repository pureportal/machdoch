import { z } from "zod";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import { maximumWebhookPayloadBytes } from "../../../lib/cloud-automation-contract";
import {
  documentInputSchema,
  loopApprovalSchema,
  loopConfigUpdateSchema,
  loopDryRunSchema,
  loopInputAnswerSchema,
  loopKillSchema,
  loopMemoryEntrySchema,
  loopSettingsUpdateSchema,
  loopSources,
  loopSourceUpdateSchema,
  loopTemplateInstallSchema,
} from "../../../lib/cloud-loop-contract";
import { CloudError } from "../access";
import { readBody, readRawBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

const documentQuerySchema = z.strictObject({ teamId: cloudId.optional() });
const sourceSchema = z.enum(loopSources);
const secretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Source is unavailable.");

export async function handleLoopSourceEvent(
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
      throw new CloudError(400, "invalid_json", "Send the event as JSON.");
    }
  return Response.json(
    await runtime.automations.sources.receive(
      cloudId.parse(path[2]),
      sourceSchema.parse(path[3]),
      secretSchema.parse(path[4]),
      payload,
    ),
    { status: 202 },
  );
}

async function handleReadRoutes(
  runtime: CloudRuntime,
  url: URL,
  actor: CloudActor,
  parts: string[],
): Promise<Response | null> {
  const { loops, sources } = runtime.automations;
  if (!parts.length) return Response.json(await loops.list(actor));
  if (parts[0] === "settings" && parts.length === 1)
    return Response.json(await loops.getSettings(actor));
  if (parts[0] === "sources" && parts.length === 1)
    return Response.json(await sources.list(actor));
  if (parts[0] === "documents" && parts.length === 1)
    return Response.json(
      await loops.listDocuments(
        actor,
        documentQuerySchema.parse(Object.fromEntries(url.searchParams))
          .teamId ?? null,
      ),
    );
  if (parts[0] === "documents" && parts.length === 2)
    return Response.json(
      await loops.getDocument(actor, cloudId.parse(parts[1])),
    );
  if (parts[0] === "runs" && parts.length === 2)
    return Response.json(await loops.runDetail(actor, cloudId.parse(parts[1])));
  if (parts.length === 1)
    return Response.json(await loops.get(actor, cloudId.parse(parts[0])));
  return null;
}

export async function handleLoopApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname
    .slice("/api/v1/loops".length)
    .split("/")
    .filter(Boolean);
  const method = request.method;
  const { loops, sources } = runtime.automations;
  if (method === "GET") {
    const response = await handleReadRoutes(runtime, url, actor, parts);
    if (response) return response;
  }
  if (method === "PATCH" && parts[0] === "sources" && parts.length === 2) {
    await sources.setEnabled(
      actor,
      sourceSchema.parse(parts[1]),
      (await readBody(request, loopSourceUpdateSchema)).enabled,
    );
    return Response.json({ ok: true });
  }
  if (
    method === "POST" &&
    parts[0] === "sources" &&
    parts[2] === "secret" &&
    parts.length === 3
  )
    return Response.json(
      await sources.rotate(actor, sourceSchema.parse(parts[1])),
    );
  const key = cloudId.parse(request.headers.get("idempotency-key"));
  if (method === "PUT" && parts[0] === "settings" && parts.length === 1)
    return Response.json(
      await loops.updateSettings(
        actor,
        key,
        await readBody(request, loopSettingsUpdateSchema),
      ),
    );
  if (method === "POST" && parts[0] === "documents" && parts.length === 1)
    return Response.json(
      await loops.createDocument(
        actor,
        key,
        await readBody(request, documentInputSchema),
      ),
    );
  if (method === "POST" && parts[0] === "templates" && parts.length === 1)
    return Response.json(
      await loops.installTemplate(
        actor,
        key,
        await readBody(request, loopTemplateInstallSchema),
      ),
    );
  if (method === "POST" && parts[0] === "runs" && parts.length === 3) {
    const runId = cloudId.parse(parts[1]);
    if (parts[2] === "approval") {
      await readBody(request, loopApprovalSchema);
      await loops.approve(actor, key, runId);
      return Response.json({ ok: true });
    }
    if (parts[2] === "input") {
      await loops.answer(
        actor,
        key,
        runId,
        (await readBody(request, loopInputAnswerSchema)).value,
      );
      return Response.json({ ok: true });
    }
    if (parts[2] === "replay")
      return Response.json(await loops.replay(actor, key, runId));
  }
  const id = cloudId.parse(parts[0]);
  if (method === "PUT" && parts[1] === "config" && parts.length === 2)
    return Response.json(
      await loops.updateConfig(
        actor,
        key,
        id,
        await readBody(request, loopConfigUpdateSchema),
      ),
    );
  if (method === "PUT" && parts[1] === "memory" && parts.length === 2)
    return Response.json(
      await loops.setMemory(
        actor,
        key,
        id,
        await readBody(request, loopMemoryEntrySchema),
      ),
    );
  if (method === "DELETE" && parts[1] === "memory" && parts.length === 3)
    return Response.json(
      await loops.deleteMemory(actor, key, id, parts[2] ?? ""),
    );
  if (method === "POST" && parts[1] === "kill" && parts.length === 2)
    return Response.json(
      await loops.setKilled(
        actor,
        key,
        id,
        (await readBody(request, loopKillSchema)).killed,
      ),
    );
  if (method === "POST" && parts[1] === "dry-run" && parts.length === 2)
    return Response.json(
      await loops.dryRun(
        actor,
        key,
        id,
        (await readBody(request, loopDryRunSchema)).runId,
      ),
    );
  throw new CloudError(404, "not_found", "Loop action is unavailable.");
}
