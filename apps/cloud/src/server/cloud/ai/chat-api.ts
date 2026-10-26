import { z } from "zod";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  chatMessageSchema,
  chatRetrySchema,
} from "../../../lib/cloud-chat-contract";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handleChatApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/v1/".length).split("/");
  if (request.method === "GET") {
    if (path[0] === "chats" && path.length === 1)
      return Response.json({
        chats: await runtime.chat.store.list(
          actor,
          cloudId
            .optional()
            .parse(url.searchParams.get("beforeId") ?? undefined),
        ),
      });
    if (path[0] === "chats" && path.length === 2)
      return Response.json(
        await runtime.chat.store.get(
          actor,
          cloudId.parse(path[1]),
          z.coerce
            .number()
            .int()
            .positive()
            .optional()
            .parse(url.searchParams.get("beforeSequence") ?? undefined),
        ),
      );
    if (path[0] === "inference-budgets" && path.length === 2)
      return Response.json(
        await runtime.chat.store.budget(actor, cloudId.parse(path[1])),
      );
  }
  if (request.method !== "POST")
    throw new CloudError(
      405,
      "method_not_allowed",
      "This chat endpoint requires POST.",
    );
  const key = cloudId.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    throw new CloudError(
      400,
      "command_key_required",
      "Provide a UUID Idempotency-Key for this change.",
    );
  if (path[0] === "chats" && path.length === 1) {
    const result = await runtime.chat.store.submit(
      actor,
      key.data,
      await readBody(request, chatMessageSchema),
    );
    runtime.inference.worker.wake();
    return Response.json(result, { status: 202 });
  }
  if (path[0] === "chat-turns" && path.length === 3) {
    const id = cloudId.parse(path[1]);
    if (path[2] === "retry") {
      const input = await readBody(request, chatRetrySchema);
      const result = await runtime.chat.store.retry(actor, key.data, id, input);
      runtime.inference.worker.wake();
      return Response.json(result, { status: 202 });
    }
    if (path[2] === "cancel") {
      const input = await readBody(
        request,
        z.strictObject({ requestId: cloudId }),
      );
      return Response.json(
        await runtime.chat.store.cancel(actor, key.data, id, input.requestId),
      );
    }
  }
  throw new CloudError(404, "not_found", "Chat endpoint does not exist.");
}
