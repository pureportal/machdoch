import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  gitAccountInputSchema,
  gitCommentInputSchema,
  gitConnectionInputSchema,
  gitMergeInputSchema,
  gitProviderSchema,
  gitRepositoryInputSchema,
  gitRetargetInputSchema,
  gitReviewInputSchema,
  gitRevisionSchema,
  gitStatusRuleInputSchema,
  gitUpdateBranchInputSchema,
  maximumGitWebhookBytes,
  pullRequestListQuerySchema,
} from "../../../lib/cloud-git-contract";
import type { GitProvider } from "../../../lib/git-providers";
import { CloudError } from "../access";
import { readBody, readRawBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

const webhookHeaders: Record<
  GitProvider,
  { event: string; delivery: string; signature: string }
> = {
  github: {
    event: "x-github-event",
    delivery: "x-github-delivery",
    signature: "x-hub-signature-256",
  },
  gitlab: {
    event: "x-gitlab-event",
    delivery: "x-gitlab-event-uuid",
    signature: "x-gitlab-token",
  },
};

export async function handleGitWebhook(
  runtime: CloudRuntime,
  request: Request,
  providerName: string,
  webhookId: string,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const provider = gitProviderSchema.parse(providerName);
  const names = webhookHeaders[provider];
  const event = request.headers.get(names.event) ?? "";
  const delivery = request.headers.get(names.delivery) ?? "";
  const signature = request.headers.get(names.signature) ?? "";
  if (!event || !delivery || delivery.length > 100 || !signature)
    throw new CloudError(400, "git_headers", "Webhook headers are missing.");
  await runtime.git.webhooks.receive(
    provider,
    cloudId.parse(webhookId),
    { event, delivery, signature },
    await readRawBody(request, maximumGitWebhookBytes),
  );
  return new Response(null, { status: 204 });
}

const oauthErrors: Record<string, string> = {
  git_oauth_state: "expired",
  git_account_taken: "taken",
};

export async function handleGitOAuthCallback(
  runtime: CloudRuntime,
  request: Request,
  providerName: string,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const provider = gitProviderSchema.parse(providerName);
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const state = query.get("state");
  const target = new URL("/cloud/account", runtime.origin);
  target.searchParams.set("tab", "git");
  if (!code || !state || code.length > 500 || state.length > 100)
    target.searchParams.set("gitError", "denied");
  else
    try {
      await runtime.git.oauth.complete(provider, code, state);
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      target.searchParams.set("gitError", oauthErrors[error.code] ?? "failed");
    }
  return new Response(null, {
    status: 303,
    headers: { Location: target.href },
  });
}

function idempotencyKey(request: Request): string {
  return cloudId.parse(request.headers.get("idempotency-key"));
}

async function handleGitSettings(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  path: string[],
): Promise<Response | null> {
  const { connections, accounts, statusRules } = runtime.git;
  const method = request.method;
  if (path.length === 1 && method === "GET")
    return Response.json(await connections.get(actor));
  if (path[1] === "accounts") {
    if (path.length === 2 && method === "GET")
      return Response.json(await accounts.get(actor));
    if (path.length === 4 && path[3] === "authorize" && method === "POST")
      return Response.json(
        await runtime.git.oauth.start(actor, gitProviderSchema.parse(path[2])),
      );
    if (path.length !== 3) return null;
    const provider = gitProviderSchema.parse(path[2]);
    if (method === "PUT")
      return Response.json(
        await accounts.connect(
          actor,
          provider,
          await readBody(request, gitAccountInputSchema),
        ),
      );
    if (method === "DELETE") {
      await accounts.disconnect(
        actor,
        provider,
        (await readBody(request, gitRevisionSchema)).revision,
      );
      return Response.json({ ok: true });
    }
    return null;
  }
  if (path.length === 2 && path[1] === "repositories" && method === "GET")
    return Response.json(await connections.repositories(actor));
  if (path.length === 2 && path[1] === "status-rules" && method === "PUT") {
    await statusRules.set(
      actor,
      await readBody(request, gitStatusRuleInputSchema),
    );
    return Response.json({ ok: true });
  }
  if (
    path.length === 4 &&
    path[1] === "repositories" &&
    path[3] === "remove" &&
    method === "POST"
  ) {
    await connections.removeRepository(actor, cloudId.parse(path[2]));
    return Response.json({ ok: true });
  }
  const provider = gitProviderSchema.parse(path[1]);
  const route = `${method} ${path.slice(2).join("/")}`;
  if (route === "PUT ")
    return Response.json(
      await connections.connect(
        actor,
        idempotencyKey(request),
        provider,
        await readBody(request, gitConnectionInputSchema),
      ),
    );
  if (route === "DELETE ") {
    await connections.disconnect(
      actor,
      provider,
      (await readBody(request, gitRevisionSchema)).revision,
    );
    return Response.json({ ok: true });
  }
  if (route === "POST sync") {
    await connections.requestSync(actor, provider);
    return Response.json({ ok: true });
  }
  if (route === "GET repositories/available")
    return Response.json({
      repositories: await connections.available(actor, provider),
    });
  if (route === "POST repositories")
    return Response.json(
      await connections.addRepository(
        actor,
        provider,
        (await readBody(request, gitRepositoryInputSchema)).fullName,
      ),
    );
  return null;
}

async function handlePullRequests(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  path: string[],
): Promise<Response | null> {
  const pullRequests = runtime.git.pullRequests;
  const method = request.method;
  if (path.length === 1 && method === "GET")
    return Response.json(
      await pullRequests.list(
        actor,
        pullRequestListQuerySchema.parse(
          Object.fromEntries(new URL(request.url).searchParams),
        ).stage,
      ),
    );
  const id = cloudId.parse(path[1]);
  const route = `${method} ${path.slice(2).join("/")}`;
  if (route === "GET ")
    return Response.json(await pullRequests.details(actor, id));
  if (route === "GET files")
    return Response.json({ files: await pullRequests.files(actor, id) });
  if (route === "POST merge")
    return Response.json(
      await pullRequests.merge(
        actor,
        id,
        await readBody(request, gitMergeInputSchema),
      ),
    );
  if (route === "POST update-branch") {
    await pullRequests.updateBranch(
      actor,
      id,
      (await readBody(request, gitUpdateBranchInputSchema)).headSha,
    );
    return Response.json({ ok: true });
  }
  if (route === "POST retarget")
    return Response.json(
      await pullRequests.retarget(
        actor,
        id,
        (await readBody(request, gitRetargetInputSchema)).baseRef,
      ),
    );
  if (route === "POST comments")
    return Response.json(
      await pullRequests.comment(
        actor,
        id,
        (await readBody(request, gitCommentInputSchema)).body,
      ),
    );
  if (route === "POST reviews")
    return Response.json(
      await pullRequests.review(
        actor,
        id,
        await readBody(request, gitReviewInputSchema),
      ),
    );
  return null;
}

export async function handleGitApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const path = new URL(request.url).pathname
    .slice("/api/v1/".length)
    .split("/");
  const response =
    path[0] === "git"
      ? await handleGitSettings(runtime, request, actor, path)
      : path[0] === "pull-requests"
        ? await handlePullRequests(runtime, request, actor, path)
        : path[0] === "issues" &&
            path[2] === "pull-requests" &&
            path.length === 3 &&
            request.method === "GET"
          ? Response.json({
              pullRequests: await runtime.git.pullRequests.forIssue(
                actor,
                cloudId.parse(path[1]),
              ),
            })
          : null;
  if (response) return response;
  throw new CloudError(
    404,
    "not_found",
    "The requested resource is unavailable.",
  );
}
