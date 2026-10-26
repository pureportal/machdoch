import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  scheduleInputSchema,
  scheduleUpdateSchema,
  scheduleStateSchema,
  scheduleQuerySchema,
  scheduleArchiveSchema,
  scheduleHistoryQuerySchema,
} from "../../../lib/cloud-schedule-contract";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import {
  sessionAccountSchema,
  type SessionAccount,
} from "../../../lib/cloud-session-contract";

function requireScheduleAccount(
  actor: CloudActor,
  account: SessionAccount,
): void {
  if (
    actor.organizationId !== account.organizationId ||
    actor.userId !== account.userId
  )
    throw new CloudError(
      409,
      "account_changed",
      "The signed-in account changed. Reload this page before changing schedules.",
    );
}

export async function handleScheduleApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname
    .slice("/api/v1/schedules".length)
    .split("/")
    .filter(Boolean);
  const method = request.method;
  if (parts.length === 1 && parts[0] === "status" && method === "GET")
    return Response.json(await runtime.schedules.status(actor));
  if (!parts.length && method === "GET") {
    const query = scheduleQuerySchema.parse(
      Object.fromEntries(url.searchParams),
    );
    return Response.json(await runtime.schedules.list(actor, query));
  }
  if (parts.length === 1 && method === "GET")
    return Response.json(
      await runtime.schedules.get(actor, cloudId.parse(parts[0])),
    );
  if (parts.length === 2 && parts[1] === "history" && method === "GET")
    return Response.json(
      await runtime.schedules.history(
        actor,
        cloudId.parse(parts[0]),
        scheduleHistoryQuerySchema.parse(Object.fromEntries(url.searchParams)),
      ),
    );
  const key = cloudId.parse(request.headers.get("idempotency-key"));
  if (parts.length === 2 && parts[1] === "archive" && method === "POST") {
    const { account, ...input } = await readBody(
      request,
      scheduleArchiveSchema.extend({ account: sessionAccountSchema }),
    );
    requireScheduleAccount(actor, account);
    return Response.json(
      await runtime.schedules.archive(
        actor,
        key,
        cloudId.parse(parts[0]),
        input,
      ),
    );
  }
  if (!parts.length && method === "POST") {
    const { account, ...input } = await readBody(
      request,
      scheduleInputSchema.extend({ account: sessionAccountSchema }),
    );
    requireScheduleAccount(actor, account);
    return Response.json(await runtime.schedules.create(actor, key, input));
  }
  if (parts.length === 1 && method === "PATCH") {
    const { account, ...input } = await readBody(
      request,
      scheduleUpdateSchema.extend({ account: sessionAccountSchema }),
    );
    requireScheduleAccount(actor, account);
    return Response.json(
      await runtime.schedules.update(
        actor,
        key,
        cloudId.parse(parts[0]),
        input,
      ),
    );
  }
  if (parts.length === 2 && parts[1] === "state" && method === "POST") {
    const { account, ...input } = await readBody(
      request,
      scheduleStateSchema.extend({ account: sessionAccountSchema }),
    );
    requireScheduleAccount(actor, account);
    return Response.json(
      await runtime.schedules.setEnabled(
        actor,
        key,
        cloudId.parse(parts[0]),
        input,
      ),
    );
  }
  throw new CloudError(404, "not_found", "Schedule action is unavailable.");
}
