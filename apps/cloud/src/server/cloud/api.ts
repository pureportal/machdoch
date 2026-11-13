import { readBody } from "./request-body";
import { credentialsInputSchema } from "../../lib/cloud-credentials-contract";
import {
  workflowDefinitionSchema,
  workflowUpdateSchema,
} from "../../lib/cloud-workflow-contract";
import {
  relationInputSchema,
  childIssueInputSchema,
} from "../../lib/cloud-relation-contract";
import {
  clearCloudCredentials,
  requireCloudOrigin,
  setCloudCredentials,
} from "./browser-auth";
import { rememberedSessionCookie } from "./auth/remembered-sessions";
import { handleMagicLinkApi, handleEmailSettingsApi } from "./auth/api";
import { handleAiActivityApi } from "./activity/api";
import {
  handleGitApi,
  handleGitOAuthCallback,
  handleGitWebhook,
} from "./git/api";
import {
  magicConfirmationCookie,
  ssoBrowserCookie,
  invitationCookie,
  clearProofCookies,
} from "./auth/proof-cookies";
import { handleInvitationAccess } from "./auth/invitations-api";
import {
  handleAccountTwoFactorApi,
  handleTwoFactorChallengeApi,
} from "./auth/two-factor-api";
import { invitationInputSchema } from "../../lib/cloud-invitation-contract";
import { recurrencePreviewSchema } from "../../lib/cloud-recurrence-contract";
import { handleScheduleApi } from "./automation/api";
import { handlePulseApi } from "./pulse/api";
import { teamResourceInputSchema } from "../../lib/cloud-team-contract";
import {
  handlePublicReleaseApi,
  handleReleaseApi,
  isPublicReleaseRoute,
  releaseRoutePrefixes,
} from "./releases/release-api";
import {
  handleAutomationApi,
  handleAutomationWebhook,
} from "./automation/automation-api";
import { browserSessionContext } from "./auth/session-context";
import {
  sessionAccountSchema,
  sessionRevocationSchema,
} from "../../lib/cloud-session-contract";
import { handleSsoApi, handleSsoSettingsApi } from "./auth/sso-api";
import {
  labelInputSchema,
  labelUpdateSchema,
  issueLabelsUpdateSchema,
} from "../../lib/cloud-label-contract";
import { handleOAuthApi } from "./oauth/api";
import { handleCloudMcp } from "./mcp/server";
import { cloudConsentSchema } from "../../lib/cloud-oauth-contract";
import { handleExecutionApi, handleRunnerApi } from "./execution/api";
import { handleAiProviderApi } from "./ai/api";
import { handleChatApi } from "./ai/chat-api";
import {
  handleAttachmentApi,
  handlePublicAttachmentApi,
  isAttachmentRoute,
  isPublicAttachmentRoute,
} from "./attachments/attachment-api";
import { z } from "zod";
import {
  memberUpdateSchema,
  organizationUpdateSchema,
  roleInputSchema,
  roleKeySchema,
  roleUpdateSchema,
  teamUpdateSchema,
} from "../../lib/cloud-administration-contract";
import { cycleCommandSchema } from "../../lib/cloud-cycle-contract";
import { inboxUpdateSchema } from "../../lib/cloud-inbox-contract";
import { issueChangesSchema } from "../../lib/cloud-issue-changes-contract";
import {
  milestoneInputSchema,
  milestoneUpdateSchema,
} from "../../lib/cloud-milestone-contract";
import { projectUpdateInputSchema } from "../../lib/cloud-project-update-contract";
import {
  favoriteInputSchema,
  subscriptionInputSchema,
} from "../../lib/cloud-favorite-contract";
import {
  initiativeInputSchema,
  initiativeUpdateSchema,
} from "../../lib/cloud-initiative-contract";
import { savedViewInputSchema } from "../../lib/cloud-view-contract";
import { triageDecisionSchema } from "../../lib/cloud-triage-contract";
import { sidebarPreferencesSchema } from "../../lib/cloud-sidebar-contract";
import {
  commentInputSchema,
  commentUpdateSchema,
} from "../../lib/cloud-comment-contract";
import {
  cloudId,
  revision,
  cycleInputSchema,
  issueInputSchema,
  issueUpdateSchema,
  pokerCommandSchema,
  pokerInputSchema,
  pokerVoteSchema,
  projectInputSchema,
  projectUpdateSchema,
  scaleUpdateSchema,
  teamInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { issueFiltersFromParameters } from "../../lib/issue-scopes";
import { CredentialValidationError } from "../crypto";
import { cookieValue } from "../request-auth";
import { CloudError, isCloudError } from "./access";
import {
  cloudCsrfCookie,
  cloudCsrfHeader,
  cloudSessionCookie,
} from "./identity";
import {
  getCloudRuntime,
  refreshCloudOrigin,
  type CloudRuntime,
} from "./runtime";
import {
  initializeInstallation,
  validateInstallationOrigin,
} from "./installation-storage";

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const loginSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
  organizationId: cloudId.optional(),
});
const querySchema = z.strictObject({
  teamId: cloudId.optional(),
  projectId: cloudId.optional(),
  cycleId: cloudId.optional(),
  labelId: cloudId.optional(),
  statusId: cloudId.optional(),
  query: z.string().max(200).optional(),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export async function handleCloudApi(
  request: Request,
  clientAddress: string,
  suppliedRuntime?: CloudRuntime,
): Promise<Response> {
  let response: Response;
  try {
    const runtime = suppliedRuntime ?? (await getCloudRuntime());
    response = await route(runtime, request, clientAddress);
  } catch (error) {
    if (isCloudError(error))
      response = Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    else if (error instanceof z.ZodError)
      response = Response.json(
        {
          error: error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "Request"}: ${issue.message}`,
            )
            .join(" "),
          code: "invalid_input",
        },
        { status: 422 },
      );
    else if (error instanceof CredentialValidationError)
      response = Response.json(
        { error: error.message, code: "invalid_password" },
        { status: 422 },
      );
    else if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["23505", "23503", "23514"].includes(String(error.code))
    )
      response = Response.json(
        {
          error:
            "This change conflicts with existing data. Reload and check the selected values.",
          code: "data_conflict",
        },
        { status: 409 },
      );
    else {
      console.error(
        "Cloud request failed",
        error instanceof Error ? error.name : "Unknown error",
      );
      response = Response.json(
        {
          error: "Cloud is unavailable. Try again shortly.",
          code: "unavailable",
        },
        { status: 503 },
      );
    }
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (response.status === 429) response.headers.set("Retry-After", "60");
  return response;
}

async function actorForRequest(
  runtime: CloudRuntime,
  request: Request,
): Promise<CloudActor> {
  const token = cookieValue(request, cloudSessionCookie) ?? "";
  const mutation = !["GET", "HEAD"].includes(request.method);
  let csrf: string | undefined;
  if (mutation) {
    requireCloudOrigin(runtime, request);
    csrf = request.headers.get(cloudCsrfHeader) ?? "";
    if (!csrf || csrf !== cookieValue(request, cloudCsrfCookie))
      throw new CloudError(
        403,
        "invalid_csrf",
        "Reload the page and try again.",
      );
  }
  const actor = await runtime.identity.authenticate(token, csrf);
  if (!actor)
    throw new CloudError(
      401,
      "authentication_required",
      "Sign in to continue.",
    );
  return actor;
}

async function route(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/.well-known/") ||
    url.pathname.startsWith("/api/v1/oauth/")
  )
    return handleOAuthApi(runtime, request, address);
  if (url.pathname === "/api/v1/mcp") return handleCloudMcp(runtime, request);
  const path = url.pathname.slice("/api/v1/".length).split("/");
  const method = request.method;
  const routeKey = `${method} ${path.join("/")}`;
  if (routeKey === "GET auth/setup") {
    const initialized = await runtime.database.transaction(async (sql) =>
      Boolean(
        (await sql.query("SELECT id FROM cloud_organizations LIMIT 1")).rows
          .length,
      ),
    );
    return Response.json({ initialized });
  }
  if (routeKey === "POST auth/setup") {
    const origin = validateInstallationOrigin(
      url.origin,
      process.env.NODE_ENV !== "production",
    );
    requireCloudOrigin({ ...runtime, origin }, request);
    await runtime.identity.limitLogin(address, "setup");
    const input = await readBody(
      request,
      z.strictObject({
        organization: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(120),
        email: emailSchema,
        password: z.string().min(1).max(1024),
      }),
    );
    await initializeInstallation(runtime.database);
    await runtime.identity.bootstrap({ ...input, origin });
    await refreshCloudOrigin(runtime);
    const credentials = await runtime.identity.login(
      input.email,
      input.password,
    );
    const response = Response.json({ ok: true }, { status: 201 });
    setCloudCredentials(
      response,
      credentials.sessionToken,
      credentials.csrfToken,
      12 * 60 * 60,
    );
    return response;
  }
  if (path[0] === "auth" && path[1] === "sso")
    return handleSsoApi(runtime, request, address);
  if (path[0] === "auth" && (path[1] === "magic" || path[1] === "methods"))
    return handleMagicLinkApi(runtime, request, address);
  if (path[0] === "auth" && path[1] === "two-factor")
    return handleTwoFactorChallengeApi(runtime, request, address);
  if (
    path[0] === "invitations" &&
    path.length === 2 &&
    ["prepare", "preview", "accept", "sso"].includes(path[1] ?? "")
  )
    return handleInvitationAccess(runtime, request, address);
  if (routeKey === "POST auth/login") {
    requireCloudOrigin(runtime, request);
    const input = await readBody(request, loginSchema);
    await runtime.identity.limitLogin(address, input.email.toLowerCase());
    const credentials = await runtime.identity.login(
      input.email,
      input.password,
      input.organizationId,
      cookieValue(request, cloudSessionCookie) ?? undefined,
      browserSessionContext(request, address),
    );
    return setCloudCredentials(
      Response.json({ ok: true }),
      credentials.sessionToken,
      credentials.csrfToken,
      12 * 60 * 60,
    );
  }
  if (path[0] === "runner") return handleRunnerApi(runtime, request);
  if (path[0] === "integrations" && path[2] === "webhooks" && path.length === 4)
    return handleGitWebhook(runtime, request, path[1] ?? "", path[3] ?? "");
  if (
    path[0] === "integrations" &&
    path[2] === "oauth" &&
    path[3] === "callback" &&
    path.length === 4
  )
    return handleGitOAuthCallback(runtime, request, path[1] ?? "");
  if (path[0] === "automations" && path[1] === "hooks" && path.length === 3)
    return handleAutomationWebhook(runtime, request, path[2] ?? "");
  if (isPublicReleaseRoute(path))
    return handlePublicReleaseApi(runtime, request, path);
  if (isPublicAttachmentRoute(path))
    return handlePublicAttachmentApi(runtime, request, path);
  if (routeKey === "POST auth/logout") {
    requireCloudOrigin(runtime, request);
    if (
      cookieValue(request, cloudSessionCookie) &&
      (!request.headers.get(cloudCsrfHeader) ||
        request.headers.get(cloudCsrfHeader) !==
          cookieValue(request, cloudCsrfCookie))
    )
      throw new CloudError(
        403,
        "invalid_csrf",
        "Sign in again to renew your request token.",
      );
    await runtime.identity.logout(
      cookieValue(request, cloudSessionCookie) ?? "",
      cookieValue(request, magicConfirmationCookie) ?? undefined,
      cookieValue(request, ssoBrowserCookie) ?? undefined,
      cookieValue(request, invitationCookie) ?? undefined,
      cookieValue(request, rememberedSessionCookie) ?? undefined,
    );
    return clearProofCookies(
      clearCloudCredentials(Response.json({ ok: true })),
    );
  }
  const actor = await actorForRequest(runtime, request);
  if (routeKey === "PUT account/credentials") {
    await runtime.identity.limitLogin(address, actor.userId);
    await runtime.authentication.credentials.change(
      actor,
      cookieValue(request, cloudSessionCookie) ?? "",
      await readBody(request, credentialsInputSchema),
    );
    return clearProofCookies(
      clearCloudCredentials(Response.json({ ok: true })),
    );
  }
  if (path[0] === "account" && path[1] === "two-factor")
    return handleAccountTwoFactorApi(runtime, request, actor, address);
  if (path[0] === "schedules")
    return handleScheduleApi(runtime, request, actor);
  if (path[0] === "automations")
    return handleAutomationApi(runtime, request, actor);
  if (path[0] === "pulse") return handlePulseApi(runtime, request, actor);
  if (releaseRoutePrefixes.has(path[0] ?? ""))
    return handleReleaseApi(runtime, request, actor);
  if (isAttachmentRoute(path))
    return handleAttachmentApi(runtime, request, actor, path);
  if (routeKey === "POST recurrence/preview")
    return Response.json(
      await runtime.recurrence.preview(
        actor,
        await readBody(request, recurrencePreviewSchema),
        request.signal,
      ),
    );
  if (routeKey === "GET invitations/options")
    return Response.json(
      await runtime.authentication.invitations.options(actor),
    );
  if (routeKey === "GET account/sessions")
    return Response.json(
      await runtime.authentication.sessions.list(
        actor,
        cookieValue(request, cloudSessionCookie) ?? "",
        sessionAccountSchema.parse(Object.fromEntries(url.searchParams)),
      ),
    );
  if (routeKey === "POST account/sessions/revoke") {
    const result = await runtime.authentication.sessions.revoke(
      actor,
      cloudId.parse(request.headers.get("idempotency-key")),
      cookieValue(request, cloudSessionCookie) ?? "",
      await readBody(request, sessionRevocationSchema),
    );
    const response = Response.json(result);
    return result.signedOut ? clearCloudCredentials(response) : response;
  }
  if (["sso-providers", "sso-policy", "sso-link"].includes(path[0] ?? ""))
    return handleSsoSettingsApi(runtime, request, actor);
  if (path[0] === "email-settings")
    return handleEmailSettingsApi(runtime, request, actor);
  if (path[0] === "ai-activity" || path[0] === "mimorii")
    return handleAiActivityApi(runtime, request, actor);
  if (
    path[0] === "git" ||
    path[0] === "pull-requests" ||
    (path[0] === "issues" && path[2] === "pull-requests" && path.length === 3)
  )
    return handleGitApi(runtime, request, actor);
  if (routeKey === "GET connections")
    return Response.json({
      connections: await runtime.authorization.connections(actor),
    });
  if (
    method === "POST" &&
    path[0] === "connections" &&
    path.length === 3 &&
    path[2] === "revoke"
  ) {
    await runtime.authorization.disconnect(actor, cloudId.parse(path[1]));
    return Response.json({ ok: true });
  }
  if (method === "POST" && path[0] === "authorizations" && path.length === 2) {
    const input = await readBody(request, cloudConsentSchema);
    return Response.json({
      redirect: await runtime.authorization.decide(
        actor,
        cloudId.parse(path[1]),
        input.approve,
        input.scopes,
        cookieValue(request, cloudSessionCookie) ?? "",
      ),
    });
  }
  if (["chats", "chat-turns", "inference-budgets"].includes(path[0] ?? ""))
    return handleChatApi(runtime, request, actor);
  if (path[0] === "ai-providers")
    return handleAiProviderApi(runtime, request, actor);
  if (
    ["execution-profiles", "execution-workers", "runs"].includes(path[0] ?? "")
  )
    return handleExecutionApi(runtime, request, actor);
  if (routeKey === "GET workspace")
    return Response.json(await runtime.planning.workspace(actor));
  if (routeKey === "GET inbox")
    return Response.json({ entries: await runtime.inbox.list(actor) });
  if (routeKey === "GET inbox/unread")
    return Response.json({ unread: await runtime.inbox.unread(actor) });
  if (routeKey === "POST inbox/update") {
    await runtime.inbox.update(
      actor,
      await readBody(request, inboxUpdateSchema),
    );
    return Response.json({ ok: true });
  }
  if (routeKey === "GET sidebar")
    return Response.json({ preferences: await runtime.sidebar.get(actor) });
  if (routeKey === "GET triage")
    return Response.json({
      issues: await runtime.triage.list(
        actor,
        cloudId.nullable().parse(url.searchParams.get("teamId")),
      ),
    });
  if (routeKey === "GET triage/counts")
    return Response.json({ counts: await runtime.triage.counts(actor) });
  if (routeKey === "GET initiatives")
    return Response.json({
      initiatives: await runtime.initiatives.list(actor),
    });
  if (method === "GET" && path[0] === "initiatives" && path.length === 2)
    return Response.json(
      await runtime.initiatives.get(actor, cloudId.parse(path[1])),
    );
  if (routeKey === "GET project-updates")
    return Response.json({ updates: await runtime.projectUpdates.feed(actor) });
  if (routeKey === "GET favorites")
    return Response.json({ favorites: await runtime.favorites.list(actor) });
  if (routeKey === "POST favorites")
    return Response.json(
      await runtime.favorites.set(
        actor,
        await readBody(request, favoriteInputSchema),
      ),
    );
  if (
    path[0] === "issues" &&
    path.length === 3 &&
    path[2] === "subscription" &&
    (method === "GET" || method === "POST")
  ) {
    const id = cloudId.parse(path[1]);
    return Response.json(
      method === "GET"
        ? await runtime.subscriptions.get(actor, id)
        : await runtime.subscriptions.set(
            actor,
            id,
            (await readBody(request, subscriptionInputSchema)).subscribed,
          ),
    );
  }
  if (routeKey === "GET views")
    return Response.json({ views: await runtime.views.list(actor) });
  if (method === "POST" && path[0] === "views" && path[2] === "remove") {
    await runtime.views.remove(actor, cloudId.parse(path[1]));
    return Response.json({ ok: true });
  }
  if (
    method === "GET" &&
    path[0] === "cycles" &&
    path.length === 3 &&
    path[2] === "burnup"
  )
    return Response.json({
      points: await runtime.cycles.burnup(actor, cloudId.parse(path[1])),
    });
  if (
    method === "GET" &&
    path[0] === "projects" &&
    path.length === 3 &&
    path[2] === "milestones"
  )
    return Response.json({
      milestones: await runtime.milestones.list(actor, cloudId.parse(path[1])),
    });
  if (
    method === "GET" &&
    path[0] === "projects" &&
    path.length === 3 &&
    path[2] === "updates"
  )
    return Response.json({
      updates: await runtime.projectUpdates.list(actor, cloudId.parse(path[1])),
    });
  if (method === "POST" && path[0] === "milestones" && path[2] === "remove") {
    await runtime.milestones.remove(actor, cloudId.parse(path[1]));
    return Response.json({ ok: true });
  }
  if (
    method === "GET" &&
    path[0] === "teams" &&
    path.length === 3 &&
    path[2] === "workflow"
  )
    return Response.json(
      await runtime.workflows.get(actor, cloudId.parse(path[1])),
    );
  if (
    method === "GET" &&
    path[0] === "teams" &&
    path.length === 3 &&
    path[2] === "labels"
  )
    return Response.json({
      labels: await runtime.labels.list(actor, cloudId.parse(path[1])),
    });
  if (method === "GET" && path[0] === "projects" && path.length === 2)
    return Response.json(
      await runtime.projects.get(actor, cloudId.parse(path[1])),
    );
  if (routeKey === "GET administration")
    return Response.json(await runtime.administration.get(actor));
  if (routeKey === "GET roles")
    return Response.json(await runtime.roles.list(actor));
  if (routeKey === "GET me/access")
    return Response.json(await runtime.roles.mine(actor));
  if (method === "DELETE" && path[0] === "roles" && path.length === 2) {
    await runtime.roles.remove(
      actor,
      roleKeySchema.parse(path[1]),
      (await readBody(request, z.strictObject({ revision }))).revision,
    );
    return Response.json({ ok: true });
  }
  if (method === "GET" && path[0] === "cycles" && path.length === 2)
    return Response.json(
      await runtime.cycles.get(actor, cloudId.parse(path[1])),
    );
  if (
    method === "GET" &&
    path[0] === "teams" &&
    path.length === 3 &&
    path[2] === "members"
  )
    return Response.json({
      memberIds: await runtime.administration.teamMembers(
        actor,
        cloudId.parse(path[1]),
      ),
    });
  if (routeKey === "POST invitations") {
    const input = await readBody(request, invitationInputSchema);
    const invitation = await runtime.authentication.invitations.create(
      actor,
      cloudId.parse(request.headers.get("idempotency-key")),
      input,
    );
    return Response.json(
      {
        id: invitation.id,
        url: `${runtime.origin}/cloud/join#${invitation.token}`,
      },
      { status: 201 },
    );
  }
  if (routeKey === "GET issues")
    return Response.json({
      issues: await runtime.planning.listIssues(
        actor,
        querySchema.parse(Object.fromEntries(url.searchParams)),
      ),
    });
  if (routeKey === "GET issues/search")
    return Response.json({
      issues: await runtime.planning.listIssueSummaries(
        actor,
        {
          query: z
            .string()
            .max(200)
            .parse(url.searchParams.get("query") ?? ""),
        },
        12,
      ),
    });
  if (routeKey === "GET issues/page")
    return Response.json({
      issues: await runtime.planning.listIssueSummaries(
        actor,
        issueFiltersFromParameters(Object.fromEntries(url.searchParams)),
      ),
    });
  if (path[0] === "issues" && path.length >= 2 && method === "GET") {
    const id = cloudId.parse(path[1]);
    if (path.length === 2)
      return Response.json(await runtime.planning.getIssue(actor, id));
    if (path.length === 3 && path[2] === "labels")
      return Response.json(await runtime.labels.getIssue(actor, id));
    if (path.length === 3 && path[2] === "relations")
      return Response.json({
        relations: await runtime.relations.list(actor, id),
      });
    if (path.length === 3 && path[2] === "comments")
      return Response.json({
        comments: await runtime.comments.list(
          actor,
          id,
          cloudId.nullable().parse(url.searchParams.get("before")),
        ),
      });
    if (path.length === 3 && path[2] === "history")
      return Response.json({
        history: await runtime.planning.history(actor, id),
      });
    if (path.length === 3 && path[2] === "poker")
      return Response.json({ rounds: await runtime.poker.list(actor, id) });
  }
  if (path[0] === "poker" && path.length === 2 && method === "GET")
    return Response.json(
      await runtime.poker.get(actor, cloudId.parse(path[1])),
    );
  if (["POST", "PATCH"].includes(method)) {
    const key = cloudId.safeParse(request.headers.get("idempotency-key"));
    if (!key.success)
      throw new CloudError(
        400,
        "command_key_required",
        "Provide a UUID Idempotency-Key for this change.",
      );
    if (method === "POST" && path[0] === "teams" && path[2] === "resources") {
      const teamId = cloudId.parse(path[1]);
      if (path.length === 3)
        return Response.json(
          await runtime.teamHomes.addResource(
            actor,
            key.data,
            teamId,
            await readBody(request, teamResourceInputSchema),
          ),
          { status: 201 },
        );
      if (path.length === 5 && path[4] === "remove") {
        await runtime.teamHomes.removeResource(
          actor,
          teamId,
          cloudId.parse(path[3]),
        );
        return Response.json({ ok: true });
      }
    }
    if (
      method === "POST" &&
      path[0] === "teams" &&
      path.length === 4 &&
      path[2] === "workflow" &&
      path[3] === "preview"
    )
      return Response.json(
        await runtime.workflows.preview(
          actor,
          cloudId.parse(path[1]),
          await readBody(request, workflowDefinitionSchema),
        ),
      );
    if (
      method === "PATCH" &&
      path[0] === "teams" &&
      path.length === 3 &&
      path[2] === "workflow"
    )
      return Response.json(
        await runtime.workflows.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, workflowUpdateSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "issues" &&
      path.length === 3 &&
      path[2] === "relations"
    )
      return Response.json(
        await runtime.relations.add(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, relationInputSchema),
        ),
        { status: 201 },
      );
    if (
      method === "POST" &&
      path[0] === "issues" &&
      path.length === 3 &&
      path[2] === "children"
    )
      return Response.json(
        await runtime.relations.createChild(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, childIssueInputSchema),
        ),
        { status: 201 },
      );
    if (
      method === "POST" &&
      path[0] === "issues" &&
      path.length === 5 &&
      path[2] === "relations" &&
      path[4] === "remove"
    )
      return Response.json(
        await runtime.relations.remove(
          actor,
          key.data,
          cloudId.parse(path[1]),
          cloudId.parse(path[3]),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "teams" &&
      path.length === 3 &&
      path[2] === "labels"
    )
      return Response.json(
        await runtime.labels.create(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, labelInputSchema),
        ),
        { status: 201 },
      );
    if (method === "PATCH" && path[0] === "labels" && path.length === 2)
      return Response.json(
        await runtime.labels.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, labelUpdateSchema),
        ),
      );
    if (
      method === "PATCH" &&
      path[0] === "issues" &&
      path.length === 3 &&
      path[2] === "labels"
    )
      return Response.json(
        await runtime.labels.setIssue(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, issueLabelsUpdateSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "issues" &&
      path.length === 3 &&
      path[2] === "comments"
    ) {
      const input = await readBody(request, commentInputSchema);
      return Response.json(
        await runtime.comments.create(
          actor,
          key.data,
          cloudId.parse(path[1]),
          input.body,
        ),
        { status: 201 },
      );
    }
    if (method === "PATCH" && path[0] === "comments" && path.length === 2)
      return Response.json(
        await runtime.comments.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, commentUpdateSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "cycles" &&
      path.length === 3 &&
      path[2] === "commands"
    )
      return Response.json(
        await runtime.cycles.act(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, cycleCommandSchema),
        ),
      );
    if (routeKey === "POST roles")
      return Response.json(
        await runtime.roles.create(
          actor,
          key.data,
          await readBody(request, roleInputSchema),
        ),
      );
    if (method === "PATCH" && path[0] === "roles" && path.length === 2)
      return Response.json(
        await runtime.roles.update(
          actor,
          key.data,
          roleKeySchema.parse(path[1]),
          await readBody(request, roleUpdateSchema),
        ),
      );
    if (routeKey === "PATCH organization")
      return Response.json(
        await runtime.administration.updateOrganization(
          actor,
          key.data,
          await readBody(request, organizationUpdateSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "members" &&
      path.length === 4 &&
      path[2] === "two-factor" &&
      path[3] === "reset"
    )
      return Response.json(
        await runtime.authentication.twoFactor.resetMember(
          actor,
          key.data,
          cloudId.parse(path[1]),
        ),
      );
    if (method === "PATCH" && path[0] === "members" && path.length === 2)
      return Response.json(
        await runtime.administration.updateMember(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, memberUpdateSchema),
        ),
      );
    if (method === "PATCH" && path[0] === "teams" && path.length === 2)
      return Response.json(
        await runtime.administration.updateTeam(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, teamUpdateSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "invitations" &&
      path.length === 3 &&
      path[2] === "revoke"
    )
      return Response.json(
        await runtime.administration.revokeInvitation(
          actor,
          key.data,
          cloudId.parse(path[1]),
        ),
      );
    if (routeKey === "POST teams")
      return Response.json(
        await runtime.planning.createTeam(
          actor,
          key.data,
          await readBody(request, teamInputSchema),
        ),
        { status: 201 },
      );
    if (routeKey === "POST initiatives")
      return Response.json(
        await runtime.initiatives.create(
          actor,
          key.data,
          await readBody(request, initiativeInputSchema),
        ),
        { status: 201 },
      );
    if (method === "PATCH" && path[0] === "initiatives" && path.length === 2)
      return Response.json(
        await runtime.initiatives.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, initiativeUpdateSchema),
        ),
      );
    if (routeKey === "POST projects")
      return Response.json(
        await runtime.projects.create(
          actor,
          key.data,
          await readBody(request, projectInputSchema),
        ),
        { status: 201 },
      );
    if (method === "PATCH" && path[0] === "projects" && path.length === 2)
      return Response.json(
        await runtime.projects.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, projectUpdateSchema),
        ),
      );
    if (routeKey === "POST cycles")
      return Response.json(
        await runtime.planning.createCycle(
          actor,
          key.data,
          await readBody(request, cycleInputSchema),
        ),
        { status: 201 },
      );
    if (routeKey === "POST issues")
      return Response.json(
        await runtime.planning.createIssue(
          actor,
          key.data,
          await readBody(request, issueInputSchema),
        ),
        { status: 201 },
      );
    if (routeKey === "POST poker") {
      const input = await readBody(request, pokerInputSchema);
      return Response.json(
        await runtime.poker.create(
          actor,
          key.data,
          input.issueId,
          input.issueRevision,
        ),
        { status: 201 },
      );
    }
    if (routeKey === "PATCH sidebar")
      return Response.json({
        preferences: await runtime.sidebar.update(
          actor,
          key.data,
          await readBody(request, sidebarPreferencesSchema),
        ),
      });
    if (
      method === "POST" &&
      path[0] === "issues" &&
      path.length === 3 &&
      path[2] === "triage"
    )
      return Response.json(
        await runtime.triage.decide(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, triageDecisionSchema),
        ),
      );
    if (routeKey === "POST issues/changes")
      return Response.json(
        await runtime.issueChanges.apply(
          actor,
          key.data,
          await readBody(request, issueChangesSchema),
        ),
      );
    if (routeKey === "POST views")
      return Response.json(
        await runtime.views.create(
          actor,
          key.data,
          await readBody(request, savedViewInputSchema),
        ),
        { status: 201 },
      );
    if (method === "PATCH" && path[0] === "views" && path.length === 2)
      return Response.json(
        await runtime.views.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, savedViewInputSchema),
        ),
      );
    if (
      method === "POST" &&
      path[0] === "projects" &&
      path.length === 3 &&
      path[2] === "milestones"
    )
      return Response.json(
        await runtime.milestones.create(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, milestoneInputSchema),
        ),
        { status: 201 },
      );
    if (
      method === "POST" &&
      path[0] === "projects" &&
      path.length === 3 &&
      path[2] === "updates"
    )
      return Response.json(
        await runtime.projectUpdates.create(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, projectUpdateInputSchema),
        ),
        { status: 201 },
      );
    if (method === "PATCH" && path[0] === "milestones" && path.length === 2)
      return Response.json(
        await runtime.milestones.update(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, milestoneUpdateSchema),
        ),
      );
    if (path[0] === "issues" && path.length === 2 && method === "PATCH")
      return Response.json(
        await runtime.planning.updateIssue(
          actor,
          key.data,
          cloudId.parse(path[1]),
          await readBody(request, issueUpdateSchema),
        ),
      );
    if (
      path[0] === "teams" &&
      path.length === 3 &&
      path[2] === "scale" &&
      method === "PATCH"
    ) {
      const input = await readBody(request, scaleUpdateSchema);
      return Response.json(
        await runtime.planning.updateScale(
          actor,
          key.data,
          cloudId.parse(path[1]),
          input.revision,
          input.estimateScale,
        ),
      );
    }
    if (path[0] === "poker" && path.length === 3 && method === "POST") {
      const id = cloudId.parse(path[1]);
      if (path[2] === "votes") {
        const input = await readBody(request, pokerVoteSchema);
        return Response.json(
          await runtime.poker.vote(
            actor,
            key.data,
            id,
            input.revision,
            input.card,
          ),
        );
      }
      if (path[2] === "commands")
        return Response.json(
          await runtime.poker.act(
            actor,
            key.data,
            id,
            await readBody(request, pokerCommandSchema),
          ),
        );
    }
  }
  throw new CloudError(404, "not_found", "This endpoint does not exist.");
}
