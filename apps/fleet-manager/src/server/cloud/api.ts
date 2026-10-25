import { readBody } from "./request-body";
import {
  workflowDefinitionSchema,
  workflowUpdateSchema,
} from "../../lib/cloud-workflow-contract";
import {
  relationInputSchema,
  childIssueInputSchema,
} from "../../lib/cloud-relation-contract";
import { requireCloudOrigin, setCloudCredentials } from "./browser-auth";
import { handleMagicLinkApi, handleEmailSettingsApi } from "./auth/api";
import {
  magicConfirmationCookie,
  ssoBrowserCookie,
  invitationCookie,
  clearProofCookies,
} from "./auth/proof-cookies";
import { handleInvitationAccess } from "./auth/invitations-api";
import { invitationInputSchema } from "../../lib/cloud-invitation-contract";
import { recurrencePreviewSchema } from "../../lib/cloud-recurrence-contract";
import { handleScheduleApi } from "./automation/api";
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
import { z } from "zod";
import {
  memberUpdateSchema,
  organizationUpdateSchema,
  teamUpdateSchema,
} from "../../lib/cloud-administration-contract";
import { cycleCommandSchema } from "../../lib/cloud-cycle-contract";
import {
  commentInputSchema,
  commentUpdateSchema,
} from "../../lib/cloud-comment-contract";
import {
  cloudId,
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
import { CredentialValidationError } from "../crypto";
import { cookieValue } from "../request-auth";
import { CloudError, isCloudError } from "./access";
import {
  cloudCsrfCookie,
  cloudCsrfHeader,
  cloudSessionCookie,
} from "./identity";
import { getCloudRuntime, type CloudRuntime } from "./runtime";

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const loginSchema = z.strictObject({
  email: emailSchema,
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
  if (path[0] === "auth" && path[1] === "sso")
    return handleSsoApi(runtime, request, address);
  if (path[0] === "auth" && (path[1] === "magic" || path[1] === "methods"))
    return handleMagicLinkApi(runtime, request, address);
  if (
    path[0] === "invitations" &&
    path.length === 2 &&
    ["prepare", "preview", "accept", "sso"].includes(path[1] ?? "")
  )
    return handleInvitationAccess(runtime, request, address);
  if (routeKey === "POST auth/login") {
    requireCloudOrigin(runtime, request);
    const input = await readBody(request, loginSchema);
    await runtime.identity.limitLogin(address, input.email);
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
    );
    const response = setCloudCredentials(
      Response.json({ ok: true }),
      "",
      "",
      0,
    );
    clearProofCookies(response);
    return response;
  }
  const actor = await actorForRequest(runtime, request);
  if (path[0] === "schedules")
    return handleScheduleApi(runtime, request, actor);
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
    return result.signedOut
      ? setCloudCredentials(response, "", "", 0)
      : response;
  }
  if (["sso-providers", "sso-policy", "sso-link"].includes(path[0] ?? ""))
    return handleSsoSettingsApi(runtime, request, actor);
  if (path[0] === "email-settings")
    return handleEmailSettingsApi(runtime, request, actor);
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
    if (routeKey === "PATCH organization")
      return Response.json(
        await runtime.administration.updateOrganization(
          actor,
          key.data,
          await readBody(request, organizationUpdateSchema),
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
