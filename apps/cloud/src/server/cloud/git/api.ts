import { randomBytes } from "node:crypto";
import { z } from "zod";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  gitAccountInputSchema,
  type CloudIssueGitActivity,
  gitCommentInputSchema,
  gitAutoMergeInputSchema,
  gitConnectionInputSchema,
  gitHubAppSetupInputSchema,
  gitMergeInputSchema,
  gitProviderSchema,
  gitRepositoryInputSchema,
  gitRepositorySettingsInputSchema,
  gitRetargetInputSchema,
  gitReviewGuideInputSchema,
  gitReviewInputSchema,
  gitReviewSettingsInputSchema,
  gitRevisionSchema,
  gitStatusRuleInputSchema,
  gitUpdateBranchInputSchema,
  maximumGitWebhookBytes,
  pullRequestListQuerySchema,
} from "../../../lib/cloud-git-contract";
import type { GitProvider } from "../../../lib/git-providers";
import { pullRequestFixInputSchema } from "../../../lib/pull-request-fixes";
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

const appSetupErrors: Record<string, string> = {
  git_app_setup: "app_expired",
  git_connection_exists: "app_exists",
};

function settingsRedirect(
  runtime: CloudRuntime,
  params: Record<string, string>,
): Response {
  const target = new URL("/cloud/settings/integrations", runtime.origin);
  for (const [key, value] of Object.entries(params))
    target.searchParams.set(key, value);
  return new Response(null, {
    status: 303,
    headers: { Location: target.href },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function registrationPage(registration: {
  action: string;
  manifest: string;
}): Response {
  const nonce = randomBytes(16).toString("base64");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect GitHub</title><form method="post" action="${escapeHtml(registration.action)}"><input type="hidden" name="manifest" value="${escapeHtml(registration.manifest)}"><button type="submit">Continue on GitHub</button></form><script nonce="${nonce}">document.forms[0].submit();</script>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(registration.action).origin}; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

export async function handleGitHubAppCallback(
  runtime: CloudRuntime,
  request: Request,
  step: string,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const installation = Number(query.get("installation_id"));
  const valid =
    state.length > 0 &&
    state.length <= 100 &&
    (step === "start" ||
      (step === "created"
        ? code.length > 0 && code.length <= 500
        : Number.isSafeInteger(installation) && installation > 0));
  if (!valid)
    return settingsRedirect(
      runtime,
      step === "installed" && !state ? {} : { gitError: "app_denied" },
    );
  try {
    if (step === "start")
      return registrationPage(await runtime.git.apps.registration(state));
    if (step === "created")
      return new Response(null, {
        status: 303,
        headers: { Location: await runtime.git.apps.created(code, state) },
      });
    return settingsRedirect(runtime, {
      gitConnected: await runtime.git.apps.installed(installation, state),
    });
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    return settingsRedirect(runtime, {
      gitError: appSetupErrors[error.code] ?? "app_failed",
    });
  }
}

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
  const target = new URL("/cloud/settings/connected-accounts", runtime.origin);
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

async function gitHubSignIn(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  rest: string[],
): Promise<Response | null> {
  const signIn = runtime.git.gitHubSignIn;
  const route = `${request.method} ${rest.join("/")}`;
  if (route === "GET ") return Response.json(await signIn.get(actor));
  if (route !== "POST " && route !== "POST cancel") return null;
  await readBody(request, z.strictObject({}));
  return Response.json(
    route === "POST " ? await signIn.start(actor) : await signIn.cancel(actor),
  );
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
    if (path[2] === "github" && path[3] === "sign-in")
      return gitHubSignIn(runtime, request, actor, path.slice(4));
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
  if (path.length === 2 && path[1] === "settings" && method === "PUT")
    return Response.json(
      await runtime.git.reviewSettings.set(
        actor,
        await readBody(request, gitReviewSettingsInputSchema),
      ),
    );
  if (
    path.length === 4 &&
    path[1] === "repositories" &&
    path[3] === "settings" &&
    method === "PUT"
  ) {
    await runtime.git.reviewSettings.setRepositorySettings(
      actor,
      cloudId.parse(path[2]),
      await readBody(request, gitRepositorySettingsInputSchema),
    );
    return Response.json({ ok: true });
  }
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
  if (
    path.length === 3 &&
    path[1] === "github" &&
    path[2] === "app" &&
    method === "POST"
  )
    return Response.json(
      await runtime.git.apps.start(
        actor,
        await readBody(request, gitHubAppSetupInputSchema),
      ),
    );
  if (path[1] === "connections" && path.length >= 3) {
    const connectionId = cloudId.parse(path[2]);
    const route = `${method} ${path.slice(3).join("/")}`;
    if (route === "DELETE ") {
      await connections.disconnect(
        actor,
        connectionId,
        (await readBody(request, gitRevisionSchema)).revision,
      );
      return Response.json({ ok: true });
    }
    if (route === "POST sync") {
      await connections.requestSync(actor, connectionId);
      return Response.json({ ok: true });
    }
    if (route === "GET repositories/available")
      return Response.json({
        repositories: await connections.available(actor, connectionId),
      });
    if (route === "POST repositories")
      return Response.json(
        await connections.addRepository(
          actor,
          connectionId,
          (await readBody(request, gitRepositoryInputSchema)).fullName,
        ),
      );
    return null;
  }
  if (path.length !== 2 || method !== "PUT") return null;
  return Response.json(
    await connections.connect(
      actor,
      idempotencyKey(request),
      gitProviderSchema.parse(path[1]),
      await readBody(request, gitConnectionInputSchema),
    ),
  );
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
  if (path.length === 2 && path[1] === "reviews" && method === "GET")
    return Response.json(await pullRequests.reviews(actor));
  const id = cloudId.parse(path[1]);
  const route = `${method} ${path.slice(2).join("/")}`;
  if (route === "GET ")
    return Response.json(await pullRequests.details(actor, id));
  if (route === "GET files")
    return Response.json({ files: await pullRequests.files(actor, id) });
  if (route === "GET guide")
    return Response.json(await runtime.git.reviewGuides.get(actor, id));
  if (route === "POST guide")
    return Response.json(
      await runtime.git.reviewGuides.start(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        id,
        await readBody(request, gitReviewGuideInputSchema),
      ),
    );
  if (route === "POST fix")
    return Response.json(
      await runtime.execution.pullRequestFixes.start(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        id,
        (await readBody(request, pullRequestFixInputSchema)).task,
      ),
    );
  if (route === "POST merge")
    return Response.json(
      await pullRequests.merge(
        actor,
        id,
        await readBody(request, gitMergeInputSchema),
      ),
    );
  if (route === "POST close") {
    await readBody(request, z.strictObject({}));
    return Response.json(await pullRequests.close(actor, id));
  }
  if (route === "PUT auto-merge") {
    await pullRequests.setAutoMerge(
      actor,
      id,
      await readBody(request, gitAutoMergeInputSchema),
    );
    return Response.json({ ok: true });
  }
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
  if (route === "POST issue") {
    await readBody(request, z.strictObject({}));
    return Response.json(await pullRequests.createIssue(actor, id));
  }
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
              commits: await runtime.git.pullRequests.issueCommits(
                actor,
                cloudId.parse(path[1]),
              ),
            } satisfies CloudIssueGitActivity)
          : path[0] === "issues" &&
              path[2] === "delivery" &&
              path.length === 3 &&
              request.method === "GET"
            ? Response.json(
                await runtime.git.delivery.read(actor, cloudId.parse(path[1])),
              )
            : null;
  if (response) return response;
  throw new CloudError(
    404,
    "not_found",
    "The requested resource is unavailable.",
  );
}
