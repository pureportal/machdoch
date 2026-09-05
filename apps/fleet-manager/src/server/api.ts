import {
  createFleetManagedSettingsEtag,
  gatewayProtocolVersion,
  managedSettingsSchemaVersion,
  maximumManagedSettingsDeliveryBytes,
  productCommandSchema,
  runCommandSchema,
  type FleetManagedSettingsDelivery,
  type FleetManagedSettingsSyncReport,
  type HostRequest,
  type HostResponse,
} from "@machdoch/fleet-protocol";
import { z } from "zod";
import { getPreviewHub, previewOpenSchema } from "./previews";
import type { AuthenticationOperation } from "./authentication-rate-limiter";
import {
  CredentialValidationError,
  createId,
  createSecret,
  validateId,
  validateSecret,
} from "./crypto";
import { nowSeconds } from "./database";
import { errorResponse, HttpError } from "./errors";
import { GatewayError } from "./gateway";
import { FleetStoreError, type EnrollmentGrant } from "./fleet-store";
import {
  bearerToken,
  clearCsrfCookie,
  clearSessionCookie,
  createBrowserCredentials,
  csrfCookie,
  hasSameOrigin,
  requireMutation,
  requireOwner,
  sessionCookie,
} from "./request-auth";
import { getRuntime, type FleetRuntime } from "./runtime";
import {
  emptySettingsDocument,
  isSecretId,
  normalizeChangeSummary,
  normalizeProfileDescription,
  normalizeProfileName,
  normalizeSecret,
  secretDescriptors,
  SettingsValidationError,
  validateSettingsDocument,
} from "./settings";
import { SettingsStoreError } from "./settings-store";

const maximumAuthenticationBodyBytes = 16 * 1024;
const maximumSettingsSyncReportBodyBytes = 16 * 1024;
const passwordValueSchema = z
  .string()
  .max(1024)
  .refine((value) => Buffer.byteLength(value) <= 1024);
const usernameValueSchema = z
  .string()
  .refine((value) => [...value].length <= 64);
const loginSchema = z.strictObject({
  username: usernameValueSchema,
  password: passwordValueSchema,
});
const passwordSchema = z.strictObject({
  username: usernameValueSchema,
  currentPassword: passwordValueSchema,
  newPassword: passwordValueSchema,
});
const enrollmentSchema = z.strictObject({
  displayName: z.string(),
  instanceSecret: z.string(),
  productVersion: z.string(),
  protocolVersion: z.number().int(),
});
const createProfileSchema = z.strictObject({
  name: z.unknown(),
  description: z.unknown().optional(),
});
const updateProfileSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  name: z.unknown(),
  description: z.unknown().optional(),
  document: z.unknown(),
  changeSummary: z.unknown().optional(),
});
const expectedRevisionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const secretSchema = expectedRevisionSchema.extend({ value: z.unknown() });
const assignmentSchema = z.strictObject({ profileId: z.string().nullable() });
const managerIdValueSchema = z
  .string()
  .refine((value) => validateId(value, "manager"));
const profileIdValueSchema = z
  .string()
  .refine((value) => validateId(value, "profile"));
const appliedSettingsSyncReportSchema = z
  .strictObject({
    managerId: managerIdValueSchema,
    status: z.literal("applied"),
    profileId: profileIdValueSchema.nullable(),
    revision: z.number().int().positive().nullable(),
  })
  .refine(
    (value) => (value.profileId === null) === (value.revision === null),
    "Applied settings identity is invalid.",
  );
const failedSettingsSyncReportSchema = z
  .strictObject({
    managerId: managerIdValueSchema,
    status: z.literal("failed"),
    profileId: profileIdValueSchema.nullable(),
    revision: z.number().int().positive().nullable(),
    error: z
      .string()
      .trim()
      .min(1)
      .refine((value) => [...value].length <= 1_000)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  })
  .refine(
    (value) => (value.profileId === null) === (value.revision === null),
    "Failed settings identity is invalid.",
  );
const settingsSyncReportSchema = z.union([
  appliedSettingsSyncReportSchema,
  failedSettingsSyncReportSchema,
]);

export interface ApiRequestContext {
  clientAddress: string;
}

export async function handleApiRequest(
  request: Request,
  context: ApiRequestContext,
): Promise<Response> {
  let response: Response;
  try {
    const runtime = getRuntime();
    const url = new URL(request.url);
    const path = apiPath(url.pathname);
    response = await routeApi(runtime, request, path, context);
  } catch (error) {
    response = errorResponse(error);
  }
  applyApiResponseHeaders(response);
  return response;
}

async function routeApi(
  runtime: FleetRuntime,
  request: Request,
  path: string[],
  context: ApiRequestContext,
): Promise<Response> {
  const method = request.method;
  if (method === "GET" && matches(path, "auth", "session"))
    return authSession(runtime, request);
  if (method === "POST" && matches(path, "auth", "login"))
    return login(runtime, request, context.clientAddress);
  if (method === "POST" && matches(path, "auth", "logout"))
    return logout(runtime, request);
  if (method === "GET" && matches(path, "auth", "account"))
    return ownerAccount(runtime, request);
  if (method === "PUT" && matches(path, "auth", "account"))
    return updateOwner(runtime, request);
  if (method === "GET" && matches(path, "auth", "sessions"))
    return listSessions(runtime, request);
  if (
    method === "DELETE" &&
    path[0] === "auth" &&
    path[1] === "sessions" &&
    path.length === 3
  ) {
    return revokeSession(runtime, request, path[2] ?? "");
  }
  if (method === "POST" && matches(path, "enrollment-keys")) {
    return createEnrollmentKey(runtime, request);
  }
  if (method === "GET" && matches(path, "enrollment-keys")) {
    requireOwner(runtime, request);
    return Response.json({
      grants: runtime.fleetStore.listEnrollmentGrants(nowSeconds()),
    });
  }
  if (
    method === "DELETE" &&
    path[0] === "enrollment-keys" &&
    path.length === 2
  ) {
    requireMutation(runtime, request);
    const grantId = path[1] ?? "";
    if (
      !validateId(grantId, "grant") ||
      !runtime.fleetStore.revokeEnrollmentGrant(grantId, nowSeconds())
    ) {
      throw new HttpError(404, "Enrollment key is no longer available.");
    }
    return Response.json({ ok: true });
  }
  if (method === "POST" && matches(path, "enroll"))
    return enroll(runtime, request);
  if (method === "GET" && matches(path, "instances"))
    return listInstances(runtime, request);
  if (method === "DELETE" && path[0] === "instances" && path.length === 2) {
    return revokeInstance(runtime, request, path[1] ?? "");
  }
  if (
    path[0] === "instances" &&
    path[2] === "product" &&
    path.length === 4 &&
    path[1]
  ) {
    if (method === "GET" && path[3] === "snapshot") {
      return instanceProductSnapshot(runtime, request, path[1]);
    }
    if (method === "POST" && path[3] === "commands") {
      return executeInstanceProductCommand(runtime, request, path[1]);
    }
  }
  if (
    method === "GET" &&
    path[0] === "instances" &&
    path[1] &&
    path[2] === "previews" &&
    path[3] &&
    path[4] === "launch" &&
    path.length === 5
  ) {
    const session = requireOwner(runtime, request);
    requireManagedInstance(runtime, path[1]);
    return getPreviewHub(runtime).launchPage(
      path[3],
      session.sessionHash,
      path[1],
    );
  }
  if (
    path[0] === "instances" &&
    path[1] &&
    path.length === 3 &&
    ["runs", "previews"].includes(path[2] ?? "")
  ) {
    const instanceId = path[1];
    const session =
      method === "GET"
        ? requireOwner(runtime, request)
        : requireMutation(runtime, request);
    requireManagedInstance(runtime, instanceId);
    const previews = getPreviewHub(runtime);
    if (path[2] === "previews") {
      if (method === "POST") {
        const input = await parseJson(request, previewOpenSchema);
        requireMutation(runtime, request);
        const launch = await previews.create(
          instanceId,
          session,
          input,
          request.signal,
        );
        return Response.json({
          url: `/api/instances/${encodeURIComponent(instanceId)}/previews/${launch.id}/launch#${launch.ticket}`,
          expiresAt: launch.expiresAt,
        });
      }
      if (method === "DELETE") {
        previews.revokeInstance(
          instanceId,
          new URL(request.url).searchParams.get("id") ?? undefined,
        );
        return Response.json({ ok: true });
      }
    } else {
      if (!runtime.gateways.supportsRuns(instanceId))
        throw new HttpError(
          503,
          "Services require a connected headless Fleet host with workspace-runs.v1 support. Update the host and start machdoch fleet service.",
        );
      const workspace = new URL(request.url).searchParams.get("workspace");
      if (!workspace || workspace.length > 12000)
        throw new HttpError(400, "Select a project.");
      if (method === "GET") {
        const result = await relay(
          runtime,
          instanceId,
          {
            type: "getWorkspaceRuns",
            workspace,
            includeLogs: new URL(request.url).searchParams.get("logs") === "1",
          },
          request.signal,
        );
        requireOwner(runtime, request);
        requireManagedInstance(runtime, instanceId);
        if (result.type === "error") throwHostError(result);
        if (result.type !== "workspaceRuns")
          throw new HttpError(502, "Invalid service status.");
        return Response.json({
          snapshot: result.snapshot,
          previewsEnabled: previews.enabled,
          previews: previews.list(instanceId),
        });
      }
      if (method === "POST") {
        const command = await parseJson(request, runCommandSchema);
        requireMutation(runtime, request);
        const result = await relay(
          runtime,
          instanceId,
          { type: "executeWorkspaceRun", workspace, command },
          request.signal,
        );
        if (result.type === "error") throwHostError(result);
        if (result.type !== "commandAccepted")
          throw new HttpError(502, "Invalid service command receipt.");
        runtime.database.audit(
          nowSeconds(),
          `service.${command.action}`,
          instanceId,
          "success",
        );
        return Response.json(result.receipt, { status: 202 });
      }
    }
    throw new HttpError(405, "Method is not supported.");
  }
  if (path[0] === "settings")
    return settingsApi(runtime, request, path.slice(1));
  if (
    method === "GET" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path.length === 3
  ) {
    return deliverSettings(runtime, request, path[2] ?? "");
  }
  if (
    method === "PUT" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path[2] &&
    path[3] === "sync-status" &&
    path.length === 4
  ) {
    return reportSettingsSync(runtime, request, path[2]);
  }
  if (path[0] === "gateway" && path[1] === "connect") {
    throw new HttpError(426, "WebSocket upgrade is required.");
  }
  throw new HttpError(404, "Route was not found.");
}

function authSession(runtime: FleetRuntime, request: Request): Response {
  const session = requireOwner(runtime, request);
  return Response.json({
    username: session.username,
    managerId: runtime.database.managerId(),
    sessionId: session.sessionId,
    settingsManagerEnabled: runtime.settingsCipher !== null,
  });
}

async function login(
  runtime: FleetRuntime,
  request: Request,
  clientAddress: string,
): Promise<Response> {
  if (!hasSameOrigin(runtime, request))
    throw new HttpError(403, "Login request was rejected.");
  const now = nowSeconds();
  requireAuthenticationAttempt(
    runtime.authenticationRateLimiter.loginAttempt(clientAddress, now),
  );
  const input = await parseJson(
    request,
    loginSchema,
    401,
    "Username or password is incorrect.",
    maximumAuthenticationBodyBytes,
  );
  const credentials = createBrowserCredentials();
  const operation = requirePasswordOperation(runtime);
  let authenticated: boolean;
  try {
    authenticated = await runtime.authStore.createOwnerSessionForCredentials(
      input.username,
      input.password,
      credentials.sessionToken,
      credentials.csrfToken,
      clientLabel(request),
      now,
      runtime.config.sessionPolicy,
    );
  } finally {
    operation.release();
  }
  if (!authenticated)
    throw new HttpError(401, "Username or password is incorrect.");
  runtime.authenticationRateLimiter.loginSucceeded(clientAddress);
  const response = Response.json({ ok: true });
  appendSessionCookies(
    response,
    runtime,
    credentials.sessionToken,
    credentials.csrfToken,
  );
  return response;
}

function logout(runtime: FleetRuntime, request: Request): Response {
  const session = requireMutation(runtime, request);
  runtime.authStore.revokeSessionByHash(session.sessionHash, nowSeconds());
  const response = Response.json({ ok: true });
  clearBrowserCookies(response);
  return response;
}

function ownerAccount(runtime: FleetRuntime, request: Request): Response {
  requireOwner(runtime, request);
  return Response.json({ account: runtime.authStore.ownerAccount() });
}

async function updateOwner(
  runtime: FleetRuntime,
  request: Request,
): Promise<Response> {
  const session = requireMutation(runtime, request);
  const now = nowSeconds();
  requireAuthenticationAttempt(
    runtime.authenticationRateLimiter.passwordConfirmationAttempt(
      session.sessionId,
      now,
    ),
  );
  const input = await parseJson(
    request,
    passwordSchema,
    400,
    "Request payload is invalid.",
    maximumAuthenticationBodyBytes,
  );
  const operation = requirePasswordOperation(runtime);
  let result;
  try {
    result = await runtime.authStore.changeOwnerAccountForSession(
      session,
      input.currentPassword,
      input.username,
      input.newPassword,
      now,
    );
  } catch (error) {
    if (error instanceof CredentialValidationError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  } finally {
    operation.release();
  }
  if (result === "incorrect-password") {
    throw new HttpError(403, "Current password is incorrect.");
  }
  if (result === "stale") {
    const response = Response.json(
      { error: "Account or browser session changed. Sign in and try again." },
      { status: 409 },
    );
    clearBrowserCookies(response);
    return response;
  }
  const response = Response.json({ ok: true });
  clearBrowserCookies(response);
  return response;
}

function listSessions(runtime: FleetRuntime, request: Request): Response {
  const current = requireOwner(runtime, request);
  return Response.json({
    sessions: runtime.authStore
      .listOwnerSessions(nowSeconds())
      .map((session) => ({
        ...session,
        current: session.sessionId === current.sessionId,
      })),
  });
}

function revokeSession(
  runtime: FleetRuntime,
  request: Request,
  sessionId: string,
): Response {
  const current = requireMutation(runtime, request);
  if (
    !validateId(sessionId, "session") ||
    !runtime.authStore.revokeSessionById(sessionId, nowSeconds())
  ) {
    throw new HttpError(404, "Browser session was not found.");
  }
  const response = Response.json({ ok: true });
  if (current.sessionId === sessionId) clearBrowserCookies(response);
  return response;
}

function createEnrollmentKey(
  runtime: FleetRuntime,
  request: Request,
): Response {
  requireMutation(runtime, request);
  const enrollmentKey = createSecret("mch_enroll");
  let grant: EnrollmentGrant;
  try {
    grant = runtime.fleetStore.createEnrollmentGrant(
      enrollmentKey,
      nowSeconds(),
      runtime.config.enrollmentPolicy,
    );
  } catch (error) {
    if (error instanceof FleetStoreError && error.code === "enrollment-limit") {
      throw new HttpError(
        409,
        "The outstanding enrollment key limit has been reached.",
      );
    }
    throw error;
  }
  return Response.json({
    enrollmentKey,
    grantId: grant.grantId,
    managerUrl: runtime.config.externalBaseUrl,
    managerId: runtime.database.managerId(),
    expiresAt: grant.expiresAt,
  });
}

async function enroll(
  runtime: FleetRuntime,
  request: Request,
): Promise<Response> {
  const enrollmentKey = bearerToken(request);
  const input = await parseJson(request, enrollmentSchema);
  if (
    !enrollmentKey ||
    !validateSecret(enrollmentKey, "mch_enroll") ||
    !validateSecret(input.instanceSecret, "mch_instance")
  ) {
    throw new HttpError(401, "Enrollment credentials are invalid.");
  }
  const displayName = input.displayName.trim();
  if (
    !displayName ||
    [...displayName].length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(displayName)
  ) {
    throw new HttpError(400, "Display name is invalid.");
  }
  const productVersion = input.productVersion.trim();
  if (
    !productVersion ||
    productVersion.length > 40 ||
    /[\p{Cc}\p{Cf}]/u.test(productVersion)
  ) {
    throw new HttpError(400, "Product version is invalid.");
  }
  if (input.protocolVersion !== gatewayProtocolVersion) {
    throw new HttpError(400, "Gateway protocol version is incompatible.");
  }
  let instanceId: string;
  try {
    instanceId = runtime.fleetStore.enrollInstance(
      {
        enrollmentKey,
        instanceSecret: input.instanceSecret,
        displayName,
        productVersion,
        protocolVersion: input.protocolVersion,
      },
      nowSeconds(),
    ).instanceId;
  } catch (error) {
    if (
      error instanceof FleetStoreError &&
      error.code === "invalid-enrollment-grant"
    ) {
      throw new HttpError(
        401,
        "Enrollment key is invalid, expired, or already used.",
      );
    }
    throw error;
  }
  return Response.json({
    managerId: runtime.database.managerId(),
    managerUrl: runtime.config.externalBaseUrl,
    instanceId,
  });
}

function listInstances(runtime: FleetRuntime, request: Request): Response {
  requireOwner(runtime, request);
  return Response.json({
    instances: runtime.fleetStore
      .listInstances()
      .map(({ revokedAt, ...instance }) => ({
        ...instance,
        status:
          revokedAt !== null
            ? "revoked"
            : runtime.gateways.isOnline(instance.instanceId)
              ? "online"
              : "offline",
      })),
  });
}

function revokeInstance(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Response {
  requireMutation(runtime, request);
  if (!runtime.fleetStore.revokeInstance(instanceId, nowSeconds())) {
    throw new HttpError(404, "Instance was not found.");
  }
  runtime.gateways.disconnect(instanceId, "Instance was revoked.");
  return Response.json({ ok: true });
}

async function instanceProductSnapshot(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<Response> {
  requireOwner(runtime, request);
  requireManagedInstance(runtime, instanceId);
  const response = await relay(
    runtime,
    instanceId,
    {
      type: "getProductSnapshot",
    },
    request.signal,
  );
  requireOwner(runtime, request);
  requireManagedInstance(runtime, instanceId);
  if (response.type === "error") throwHostError(response);
  if (response.type !== "productSnapshot") {
    throw new HttpError(502, "Instance returned an invalid product response.");
  }
  return Response.json(response.snapshot);
}

async function executeInstanceProductCommand(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<Response> {
  requireMutation(runtime, request);
  requireManagedInstance(runtime, instanceId);
  const input = await parseJson(request, productCommandSchema);
  const command = {
    ...input,
    commandId: input.commandId ?? createId("command"),
  };
  requireMutation(runtime, request);
  requireManagedInstance(runtime, instanceId);
  const response = await relay(
    runtime,
    instanceId,
    {
      type: "executeProductCommand",
      command,
    },
    request.signal,
  );
  if (response.type === "error") throwHostError(response);
  if (
    response.type !== "commandAccepted" ||
    response.receipt.commandId !== command.commandId
  ) {
    throw new HttpError(502, "Instance returned an invalid product response.");
  }
  return Response.json(response.receipt, { status: 202 });
}

async function settingsApi(
  runtime: FleetRuntime,
  request: Request,
  path: string[],
): Promise<Response> {
  requireSettings(runtime);
  try {
    if (request.method === "GET" && matches(path, "catalog")) {
      requireOwner(runtime, request);
      const limits = runtime.config.settingsManager.limits;
      return Response.json({
        secrets: secretDescriptors,
        limits: {
          maximumProfiles: limits.maximumProfiles,
          maximumInstructionsPerProfile: limits.maximumInstructionsPerProfile,
          maximumPacksPerProfile: limits.maximumPacksPerProfile,
          maximumPromptsPerProfile: limits.maximumPromptsPerProfile,
          maximumDocumentBytes: limits.maximumDocumentBytes,
          maximumSecretBytes: limits.maximumSecretBytes,
        },
      });
    }
    if (request.method === "GET" && matches(path, "profiles")) {
      requireOwner(runtime, request);
      return Response.json({ profiles: runtime.settingsStore.listProfiles() });
    }
    if (request.method === "POST" && matches(path, "profiles")) {
      requireMutation(runtime, request);
      const input = await parseJson(request, createProfileSchema);
      const name = normalizeProfileName(input.name);
      const description = normalizeProfileDescription(input.description);
      const document = emptySettingsDocument();
      const profileId = runtime.settingsStore.createProfile(
        name,
        description,
        document,
        nowSeconds(),
        runtime.config.settingsManager.limits.maximumProfiles,
      );
      return Response.json({
        profile: runtime.settingsStore.getProfile(profileId),
      });
    }
    const profileId = path[1];
    if (path[0] === "profiles" && profileId) {
      validateProfileId(profileId);
      if (request.method === "GET" && path.length === 2) {
        requireOwner(runtime, request);
        return Response.json({
          profile: runtime.settingsStore.getProfile(profileId),
        });
      }
      if (request.method === "PUT" && path.length === 2) {
        requireMutation(runtime, request);
        const input = await parseJson(request, updateProfileSchema);
        runtime.settingsStore.updateProfile(
          profileId,
          input.expectedRevision,
          normalizeProfileName(input.name),
          normalizeProfileDescription(input.description),
          validateSettingsDocument(
            input.document,
            runtime.config.settingsManager.limits,
          ),
          normalizeChangeSummary(input.changeSummary),
          nowSeconds(),
          runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
        );
        return Response.json({
          profile: runtime.settingsStore.getProfile(profileId),
        });
      }
      if (request.method === "DELETE" && path.length === 2) {
        requireMutation(runtime, request);
        runtime.settingsStore.deleteProfile(profileId, nowSeconds());
        return Response.json({ ok: true });
      }
      if (
        request.method === "GET" &&
        path[2] === "versions" &&
        path.length === 3
      ) {
        requireOwner(runtime, request);
        return Response.json({
          versions: runtime.settingsStore.listVersions(profileId),
        });
      }
      if (
        request.method === "POST" &&
        path[2] === "versions" &&
        path[4] === "restore"
      ) {
        requireMutation(runtime, request);
        const revision = Number(path[3]);
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new HttpError(404, "Revision was not found.");
        const input = await parseJson(request, expectedRevisionSchema);
        runtime.settingsStore.restoreVersion(
          profileId,
          revision,
          input.expectedRevision,
          nowSeconds(),
          runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
        );
        return Response.json({
          profile: runtime.settingsStore.getProfile(profileId),
        });
      }
      if (path[2] === "secrets" && path[3] && path.length === 4) {
        const secretId = path[3];
        if (!isSecretId(secretId))
          throw new HttpError(404, "Secret type was not found.");
        requireMutation(runtime, request);
        if (request.method === "PUT") {
          const input = await parseJson(request, secretSchema);
          runtime.settingsStore.setSecret(
            runtime.settingsCipher!,
            profileId,
            secretId,
            normalizeSecret(input.value, runtime.config.settingsManager.limits),
            input.expectedRevision,
            nowSeconds(),
            runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
          );
          return Response.json({
            profile: runtime.settingsStore.getProfile(profileId),
          });
        }
        if (request.method === "DELETE") {
          const input = await parseJson(request, expectedRevisionSchema);
          runtime.settingsStore.deleteSecret(
            profileId,
            secretId,
            input.expectedRevision,
            nowSeconds(),
            runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
          );
          return Response.json({
            profile: runtime.settingsStore.getProfile(profileId),
          });
        }
      }
    }
    if (request.method === "GET" && matches(path, "assignments")) {
      requireOwner(runtime, request);
      return Response.json({
        assignments: runtime.settingsStore
          .listAssignments()
          .map((assignment) => ({
            ...assignment,
            instanceStatus:
              assignment.instanceStatus === "revoked"
                ? "revoked"
                : runtime.gateways.isOnline(assignment.instanceId)
                  ? "online"
                  : "offline",
          })),
      });
    }
    if (
      request.method === "PUT" &&
      path[0] === "instances" &&
      path[1] &&
      path[2] === "assignment" &&
      path.length === 3
    ) {
      requireMutation(runtime, request);
      const input = await parseJson(request, assignmentSchema);
      runtime.settingsStore.setAssignment(
        path[1],
        input.profileId,
        nowSeconds(),
      );
      return Response.json({ ok: true });
    }
    throw new HttpError(404, "Route was not found.");
  } catch (error) {
    if (error instanceof SettingsStoreError) throw settingsHttpError(error);
    if (error instanceof HttpError) throw error;
    if (error instanceof SettingsValidationError)
      throw new HttpError(400, error.message);
    throw error;
  }
}

function deliverSettings(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Response {
  authenticateSettingsInstance(runtime, request, instanceId);
  const managerId = runtime.database.managerId();
  const identity = runtime.settingsStore.getDeliveryIdentity(instanceId);
  const candidateEtag = createFleetManagedSettingsEtag({
    managerId,
    profile: identity,
  });
  if (etagMatches(request.headers.get("If-None-Match"), candidateEtag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: candidateEtag },
    });
  }
  const delivery = runtime.settingsStore.getDelivery(
    runtime.settingsCipher!,
    instanceId,
  );
  const response: FleetManagedSettingsDelivery = {
    schemaVersion: managedSettingsSchemaVersion,
    managerId,
    profile: delivery,
  };
  const etag = createFleetManagedSettingsEtag(response);
  const body = JSON.stringify(response);
  if (Buffer.byteLength(body) > maximumManagedSettingsDeliveryBytes) {
    throw new Error("Managed settings delivery exceeds the protocol limit.");
  }
  return new Response(body, {
    headers: { "Content-Type": "application/json", ETag: etag },
  });
}

async function reportSettingsSync(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<Response> {
  authenticateSettingsInstance(runtime, request, instanceId);
  const input: FleetManagedSettingsSyncReport = await parseJson(
    request,
    settingsSyncReportSchema,
    400,
    "Request payload is invalid.",
    maximumSettingsSyncReportBodyBytes,
  );
  if (input.managerId !== runtime.database.managerId()) {
    throw new HttpError(
      409,
      "Settings assignment changed during synchronization.",
    );
  }
  const now = nowSeconds();
  if (input.status === "failed") {
    if (
      !runtime.settingsStore.recordFailure(
        instanceId,
        input.profileId,
        input.revision,
        input.error,
        now,
      )
    ) {
      throw new HttpError(
        409,
        "Settings assignment changed during synchronization.",
      );
    }
  } else {
    if (
      !runtime.settingsStore.recordApplied(
        instanceId,
        input.profileId,
        input.revision,
        now,
      )
    ) {
      throw new HttpError(
        409,
        "Settings assignment changed during synchronization.",
      );
    }
  }
  return new Response(null, { status: 204 });
}

function authenticateSettingsInstance(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): void {
  requireSettings(runtime);
  const secret = bearerToken(request);
  if (
    !validateId(instanceId, "instance") ||
    !secret ||
    !validateSecret(secret, "mch_instance") ||
    !runtime.fleetStore.authenticateInstance(instanceId, secret)
  ) {
    throw new HttpError(401, "Instance credentials are invalid.");
  }
}

function etagMatches(value: string | null, etag: string): boolean {
  return value
    ? value.split(",").some((candidate) => {
        const normalized = candidate.trim().replace(/^W\//u, "");
        return normalized === "*" || normalized === etag;
      })
    : false;
}

async function relay(
  runtime: FleetRuntime,
  instanceId: string,
  request: HostRequest,
  signal?: AbortSignal,
): Promise<HostResponse> {
  try {
    return await runtime.gateways.relay(instanceId, request, signal);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    const failure = {
      offline: [503, "Instance is offline."],
      closed: [503, "Instance is offline."],
      cancelled: [408, "Request was cancelled."],
      timeout: [504, "Instance did not respond in time."],
      busy: [429, "Instance has too many active requests."],
      protocol: [502, "Instance returned an invalid gateway response."],
    }[error.reason] as [number, string];
    throw new HttpError(failure[0], failure[1]);
  }
}

function throwHostError(
  response: Extract<HostResponse, { type: "error" }>,
): never {
  const status = {
    invalidRequest: 400,
    conflict: 409,
    unavailable: 503,
    internal: 502,
  }[response.code];
  throw new HttpError(status, response.message);
}

function requireManagedInstance(
  runtime: FleetRuntime,
  instanceId: string,
): void {
  if (!validateId(instanceId, "instance")) {
    throw new HttpError(404, "Instance was not found.");
  }
  const instance = runtime.fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) {
    throw new HttpError(404, "Instance was not found.");
  }
}

function requireSettings(runtime: FleetRuntime): void {
  if (!runtime.settingsCipher) throw new HttpError(404, "Route was not found.");
}

function validateProfileId(profileId: string): void {
  if (!validateId(profileId, "profile"))
    throw new HttpError(404, "Settings profile was not found.");
}

function settingsHttpError(error: SettingsStoreError): HttpError {
  const mapped = {
    "not-found": [404, "Settings profile was not found."],
    "revision-conflict": [
      409,
      "Settings profile changed. Reload it and try again.",
    ],
    "profile-limit": [
      409,
      "The configured settings profile limit has been reached.",
    ],
    "name-conflict": [409, "A settings profile already uses that name."],
  }[error.code] as [number, string];
  return new HttpError(mapped[0], mapped[1]);
}

async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  status = 400,
  message = "Request payload is invalid.",
  maximumBodyBytes?: number,
): Promise<z.output<T>> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  let input: unknown;
  if (maximumBodyBytes !== undefined) {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBodyBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    let body: string;
    try {
      body = await request.text();
    } catch {
      throw new HttpError(status, message);
    }
    if (Buffer.byteLength(body) > maximumBodyBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    try {
      input = JSON.parse(body) as unknown;
    } catch {
      throw new HttpError(status, message);
    }
  } else {
    try {
      input = await request.json();
    } catch {
      throw new HttpError(status, message);
    }
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(status, message);
  return result.data;
}

function apiPath(pathname: string): string[] {
  const encoded = pathname.split("/").filter(Boolean);
  let path: string[];
  try {
    path = encoded.map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Request path is invalid.");
  }
  if (path.shift() !== "api") throw new HttpError(404, "Route was not found.");
  return path;
}

function requireAuthenticationAttempt(result: {
  allowed: boolean;
  retryAfterSeconds: number;
}): void {
  if (result.allowed) return;
  throw new HttpError(
    429,
    "Too many authentication attempts. Try again later.",
    { "Retry-After": String(result.retryAfterSeconds) },
  );
}

function requirePasswordOperation(
  runtime: FleetRuntime,
): AuthenticationOperation {
  const operation = runtime.authenticationRateLimiter.beginPasswordOperation();
  if (!operation) {
    throw new HttpError(
      429,
      "Too many authentication attempts. Try again later.",
      { "Retry-After": "1" },
    );
  }
  return operation;
}

function applyApiResponseHeaders(response: Response): void {
  response.headers.set("Cache-Control", "no-store");
  if (!response.headers.has("Content-Security-Policy"))
    response.headers.set("Content-Security-Policy", "default-src 'none'");
  if (!response.headers.has("Referrer-Policy"))
    response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Strict-Transport-Security", "max-age=31536000");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
}

function matches(path: string[], ...expected: string[]): boolean {
  return (
    path.length === expected.length &&
    path.every((value, index) => value === expected[index])
  );
}

function clientLabel(request: Request): string {
  const userAgent = request.headers.get("user-agent")?.trim();
  if (!userAgent || /[\p{Cc}\p{Cf}]/u.test(userAgent)) return "Browser";
  return [...userAgent].slice(0, 160).join("");
}

function appendSessionCookies(
  response: Response,
  runtime: FleetRuntime,
  sessionToken: string,
  csrfToken: string,
): void {
  response.headers.append(
    "Set-Cookie",
    sessionCookie(sessionToken, runtime.config.sessionPolicy.absoluteSeconds),
  );
  response.headers.append(
    "Set-Cookie",
    csrfCookie(csrfToken, runtime.config.sessionPolicy.absoluteSeconds),
  );
}

function clearBrowserCookies(response: Response): void {
  response.headers.append("Set-Cookie", clearSessionCookie());
  response.headers.append("Set-Cookie", clearCsrfCookie());
}
