import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  aiActivityQuerySchema,
  mimoriiRemovalSchema,
  mimoriiSettingsInputSchema,
} from "../../../lib/cloud-activity-contract";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

const activeConnectionTests = new Set<string>();

export async function handleAiActivityApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.slice("/api/v1/".length)}`;
  const { feed, mimorii } = runtime.activity;
  if (route === "GET ai-activity")
    return Response.json(
      await feed.list(
        actor,
        aiActivityQuerySchema.parse(Object.fromEntries(url.searchParams)),
      ),
    );
  if (route === "GET mimorii") return Response.json(await mimorii.get(actor));
  if (route === "PUT mimorii")
    return Response.json(
      await mimorii.save(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        await readBody(request, mimoriiSettingsInputSchema),
      ),
    );
  if (route === "DELETE mimorii")
    return Response.json(
      await mimorii.remove(
        actor,
        (await readBody(request, mimoriiRemovalSchema)).revision,
      ),
    );
  if (route === "POST mimorii/test") {
    if (activeConnectionTests.has(actor.organizationId))
      throw new CloudError(
        429,
        "mimorii_test_busy",
        "A Mimorii connection test is already running.",
      );
    activeConnectionTests.add(actor.organizationId);
    try {
      return Response.json(await mimorii.test(actor));
    } finally {
      activeConnectionTests.delete(actor.organizationId);
    }
  }
  throw new CloudError(
    404,
    "not_found",
    "The requested resource is unavailable.",
  );
}
