import {
  gatewayProtocolVersion,
  managedSettingsSchemaVersion,
  productCommandSchema,
  type FleetManagedSettingsDelivery,
  type HostRequest,
  type HostResponse,
} from "@machdoch/fleet-protocol";
import { z } from "zod";
import { createSecret, validateId, validateSecret } from "./crypto";
import { nowSeconds } from "./database";
import { errorResponse, HttpError } from "./errors";
import { GatewayError } from "./gateway";
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

const loginSchema = z.strictObject({
  username: z.string().max(64),
  password: z.string().max(1024),
});
const passwordSchema = z.strictObject({
  username: z.string(),
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
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

export async function handleApiRequest(request: Request): Promise<Response> {
  try {
    const runtime = getRuntime();
    const url = new URL(request.url);
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(1)
      .map(decodeURIComponent);
    const response = await routeApi(runtime, request, path);
    response.headers.set(
      "Cache-Control",
      "no-cache, no-store, must-revalidate",
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

async function routeApi(
  runtime: FleetRuntime,
  request: Request,
  path: string[],
): Promise<Response> {
  const method = request.method;
  if (method === "GET" && matches(path, "auth", "session"))
    return authSession(runtime, request);
  if (method === "POST" && matches(path, "auth", "login"))
    return login(runtime, request);
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
): Promise<Response> {
  if (!hasSameOrigin(runtime, request))
    throw new HttpError(403, "Login request was rejected.");
  const input = await parseJson(
    request,
    loginSchema,
    401,
    "Username or password is incorrect.",
  );
  const now = nowSeconds();
  if (!runtime.loginThrottle.allows(now)) {
    throw new HttpError(429, "Too many login attempts. Try again shortly.");
  }
  if (!runtime.authStore.verifyOwner(input.username, input.password, now)) {
    runtime.loginThrottle.failure(now);
    throw new HttpError(401, "Username or password is incorrect.");
  }
  runtime.loginThrottle.success();
  const credentials = createBrowserCredentials();
  runtime.authStore.createOwnerSession(
    input.username,
    credentials.sessionToken,
    credentials.csrfToken,
    clientLabel(request),
    now,
    runtime.config.sessionPolicy,
  );
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
  const input = await parseJson(request, passwordSchema);
  if (
    !runtime.authStore.verifyOwner(
      session.username,
      input.currentPassword,
      nowSeconds(),
    )
  ) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  try {
    runtime.authStore.changeOwnerPassword(
      input.username,
      input.newPassword,
      nowSeconds(),
    );
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Account update failed.",
    );
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
  let expiresAt: number;
  try {
    expiresAt = runtime.fleetStore.createEnrollmentGrant(
      enrollmentKey,
      nowSeconds(),
      runtime.config.enrollmentPolicy,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("outstanding enrollment")
    ) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
  return Response.json({
    enrollmentKey,
    managerUrl: runtime.config.externalBaseUrl,
    managerId: runtime.database.managerId(),
    expiresAt,
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
    /\p{Cc}/u.test(displayName)
  ) {
    throw new HttpError(400, "Display name is invalid.");
  }
  const productVersion = input.productVersion.trim();
  if (
    !productVersion ||
    productVersion.length > 40 ||
    /\p{Cc}/u.test(productVersion)
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
  } catch {
    throw new HttpError(
      401,
      "Enrollment key is invalid, expired, or already used.",
    );
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
        status: revokedAt
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
  const response = await relay(runtime, instanceId, {
    type: "getProductSnapshot",
  });
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
  const command = await parseJson(request, productCommandSchema);
  const response = await relay(runtime, instanceId, {
    type: "executeProductCommand",
    command,
  });
  if (response.type === "error") throwHostError(response);
  if (response.type !== "commandAccepted") {
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
  requireSettings(runtime);
  const secret = bearerToken(request);
  if (
    !validateId(instanceId, "instance") ||
    !secret ||
    !runtime.fleetStore.authenticateInstance(instanceId, secret)
  ) {
    throw new HttpError(401, "Instance credentials are invalid.");
  }
  const delivery = runtime.settingsStore.getDelivery(
    runtime.settingsCipher!,
    instanceId,
  );
  if (!delivery) {
    const response: FleetManagedSettingsDelivery = {
      schemaVersion: managedSettingsSchemaVersion,
      assigned: false,
    };
    return Response.json(response);
  }
  runtime.settingsStore.recordFetch(
    instanceId,
    delivery.revision,
    nowSeconds(),
  );
  const response: FleetManagedSettingsDelivery = {
    schemaVersion: managedSettingsSchemaVersion,
    assigned: true,
    managerId: runtime.database.managerId(),
    profile: delivery,
  };
  return Response.json(response);
}

async function relay(
  runtime: FleetRuntime,
  instanceId: string,
  request: HostRequest,
): Promise<HostResponse> {
  try {
    return await runtime.gateways.relay(instanceId, request);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    const failure = {
      offline: [503, "Instance is offline."],
      closed: [503, "Instance is offline."],
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
): Promise<z.output<T>> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new HttpError(status, message);
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(status, message);
  return result.data;
}

function matches(path: string[], ...expected: string[]): boolean {
  return (
    path.length === expected.length &&
    path.every((value, index) => value === expected[index])
  );
}

function clientLabel(request: Request): string {
  const userAgent = request.headers.get("user-agent")?.trim();
  if (!userAgent || /\p{Cc}/u.test(userAgent)) return "Browser";
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
