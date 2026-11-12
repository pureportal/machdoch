import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  githubAutomationInputSchema,
  githubConnectionInputSchema,
  githubMergeInputSchema,
  githubRepositoryInputSchema,
  githubRevisionSchema,
  githubUpdateBranchInputSchema,
  maximumGitHubWebhookBytes,
  pullRequestListQuerySchema,
} from "../../../lib/cloud-github-contract";
import { CloudError } from "../access";
import { readBody, readRawBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handleGitHubWebhook(
  runtime: CloudRuntime,
  request: Request,
  webhookId: string,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!event || !delivery || delivery.length > 100 || !signature)
    throw new CloudError(400, "github_headers", "GitHub headers are missing.");
  await runtime.github.sync.receive(
    cloudId.parse(webhookId),
    { event, delivery, signature },
    await readRawBody(request, maximumGitHubWebhookBytes),
  );
  return new Response(null, { status: 204 });
}

export async function handleGitHubApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/v1/".length).split("/");
  const route = `${request.method} ${path.join("/")}`;
  const { connections, automations, pullRequests } = runtime.github;
  if (route === "GET github")
    return Response.json(await connections.get(actor));
  if (route === "PUT github")
    return Response.json(
      await connections.connect(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        await readBody(request, githubConnectionInputSchema),
      ),
    );
  if (route === "DELETE github") {
    await connections.disconnect(
      actor,
      (await readBody(request, githubRevisionSchema)).revision,
    );
    return Response.json({ ok: true });
  }
  if (route === "PUT github/automations") {
    await automations.set(
      actor,
      await readBody(request, githubAutomationInputSchema),
    );
    return Response.json({ ok: true });
  }
  if (route === "GET pull-requests")
    return Response.json(
      await pullRequests.list(
        actor,
        pullRequestListQuerySchema.parse(Object.fromEntries(url.searchParams))
          .stage,
      ),
    );
  if (
    request.method === "GET" &&
    path[0] === "pull-requests" &&
    path[2] === "files" &&
    path.length === 3
  )
    return Response.json({
      files: await pullRequests.files(actor, cloudId.parse(path[1])),
    });
  if (
    request.method === "POST" &&
    path[0] === "pull-requests" &&
    path[2] === "update-branch" &&
    path.length === 3
  ) {
    await pullRequests.updateBranch(
      actor,
      cloudId.parse(path[1]),
      (await readBody(request, githubUpdateBranchInputSchema)).headSha,
    );
    return Response.json({ ok: true });
  }
  if (route === "POST github/sync") {
    await connections.requestSync(actor);
    return Response.json({ ok: true });
  }
  if (route === "GET github/repositories/available")
    return Response.json({
      repositories: await connections.available(actor),
    });
  if (route === "POST github/repositories")
    return Response.json(
      await connections.addRepository(
        actor,
        (await readBody(request, githubRepositoryInputSchema)).fullName,
      ),
    );
  if (
    request.method === "POST" &&
    path[0] === "github" &&
    path[1] === "repositories" &&
    path[3] === "remove" &&
    path.length === 4
  ) {
    await connections.removeRepository(actor, cloudId.parse(path[2]));
    return Response.json({ ok: true });
  }
  if (
    request.method === "GET" &&
    path[0] === "issues" &&
    path[2] === "pull-requests" &&
    path.length === 3
  )
    return Response.json({
      pullRequests: await pullRequests.forIssue(actor, cloudId.parse(path[1])),
    });
  if (
    request.method === "GET" &&
    path[0] === "pull-requests" &&
    path.length === 2
  )
    return Response.json(
      await pullRequests.details(actor, cloudId.parse(path[1])),
    );
  if (
    request.method === "POST" &&
    path[0] === "pull-requests" &&
    path[2] === "merge" &&
    path.length === 3
  )
    return Response.json(
      await pullRequests.merge(
        actor,
        cloudId.parse(path[1]),
        await readBody(request, githubMergeInputSchema),
      ),
    );
  throw new CloudError(
    404,
    "not_found",
    "The requested resource is unavailable.",
  );
}
