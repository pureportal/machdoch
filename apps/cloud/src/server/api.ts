import { workspaceLibraryCapability } from "@machdoch/fleet-protocol/workspace-library";
import {
  speechRequestSchema,
  speechCapability,
  mediaRequestSchema,
  ralphRequestSchema,
  ralphEditorCapability,
  schedulerRequestSchema,
  schedulerEditorCapability,
  instructionRequestSchema,
  instructionEditorCapability,
  workspaceRequestSchema,
  workspaceToolsCapability,
  maximumWorkspaceRequestBodyBytes,
  deviceSettingsRequestSchema,
  deviceSettingsCapability,
  maximumDeviceSettingsRequestBodyBytes,
  hostRequestSchema,
} from "@machdoch/fleet-protocol";
import {
  createFleetManagedSettingsEtag,
  gatewayProtocolVersion,
  managedSettingsSchemaVersion,
  maximumManagedSettingsDeliveryBytes,
  productCommandSchema,
  runCommandSchema,
  type FleetManagedSettingsDelivery,
  type FleetManagedSettingsSyncReport,
} from "@machdoch/fleet-protocol";
import { z } from "zod";
import { handleCloudApi } from "./cloud/api";
import { streamSpeechAudio } from "./speech-audio";
import { scopeSpeechRequest } from "./speech-identity";
import {
  captureEnrollmentSettings,
  listEnrollmentSettings,
  readEnrollmentSettings,
} from "./enrollment-settings";
import packageJson from "../../package.json";
import { productVersionStatus } from "../lib/product-version";
import { collectFleetStatus } from "./fleet-status";
import { fleetSessionRequestSchema } from "../lib/fleet-session-routing";
import { openFleetSession } from "./fleet-sessions";
import {
  relayInstanceRequest as relay,
  requireManagedInstance,
  throwHostError,
} from "./instance-relay";
import { getPreviewHub, previewOpenSchema } from "./previews";
import {
  createId,
  createSecret,
  hashSecret,
  validateId,
  validateSecret,
} from "./crypto";
import { nowSeconds } from "./database";
import { errorResponse, HttpError } from "./errors";
import { FleetStoreError, type EnrollmentGrant } from "./fleet-store";
import {
  bearerToken,
  cookieValue,
  sessionCookieName,
  requireMutation,
  requireOwner,
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
import {
  maximumMediaRequestBodyBytes,
  maximumFleetSessionRequestBodyBytes,
} from "./request-limits";

const productOperationSchemas = {
  speech: speechRequestSchema,
  deviceSettings: deviceSettingsRequestSchema,
  media: mediaRequestSchema,
  ralph: ralphRequestSchema,
  scheduler: schedulerRequestSchema,
  instructions: instructionRequestSchema,
  workspace: workspaceRequestSchema,
};
const productOperationCapabilities: Partial<
  Record<
    keyof typeof productOperationSchemas,
    { capability: string; message: string }
  >
> = {
  speech: {
    capability: speechCapability,
    message: "Update this device to use Text to Speech remotely.",
  },
  deviceSettings: {
    capability: deviceSettingsCapability,
    message: "Device settings require a native client.",
  },
  ralph: {
    capability: ralphEditorCapability,
    message: "Update this device to edit RALPH flows.",
  },
  scheduler: {
    capability: schedulerEditorCapability,
    message: "Update this device to manage scheduled jobs.",
  },
  instructions: {
    capability: instructionEditorCapability,
    message: "Update this device to edit instructions.",
  },
  workspace: {
    capability: workspaceToolsCapability,
    message: "Workspace tools require a native client.",
  },
};
const maximumSettingsSyncReportBodyBytes = 16 * 1024;
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
  if (
    new URL(request.url).pathname.startsWith("/api/v1/") ||
    new URL(request.url).pathname.startsWith("/.well-known/oauth-")
  )
    return handleCloudApi(request, context.clientAddress);
  let response: Response;
  try {
    const runtime = getRuntime();
    const url = new URL(request.url);
    const path = apiPath(url.pathname);
    const token = cookieValue(request, sessionCookieName);
    response =
      token && path[0] !== "client" && path[0] !== "enroll"
        ? await runtime.database.withSession(hashSecret(token), () =>
            routeApi(runtime, request, path),
          )
        : await routeApi(runtime, request, path);
  } catch (error) {
    response = errorResponse(
      error instanceof SettingsValidationError
        ? new HttpError(400, error.message)
        : error,
    );
  }
  applyApiResponseHeaders(response);
  return response;
}

async function routeApi(
  runtime: FleetRuntime,
  request: Request,
  path: string[],
): Promise<Response> {
  const method = request.method;
  if (method === "POST" && matches(path, "enrollment-keys")) {
    return await createEnrollmentKey(runtime, request);
  }
  if (method === "GET" && matches(path, "enrollment-keys")) {
    await requireOwner(runtime, request);
    return Response.json({
      grants: await runtime.fleetStore.listEnrollmentGrants(nowSeconds()),
    });
  }
  if (
    method === "DELETE" &&
    path[0] === "enrollment-keys" &&
    path.length === 2
  ) {
    await requireMutation(runtime, request);
    const grantId = path[1] ?? "";
    if (
      !validateId(grantId, "grant") ||
      !(await runtime.fleetStore.revokeEnrollmentGrant(grantId, nowSeconds()))
    ) {
      throw new HttpError(404, "Enrollment key is no longer available.");
    }
    return Response.json({ ok: true });
  }
  if (method === "POST" && matches(path, "enroll"))
    return await enroll(runtime, request);
  if (method === "GET" && matches(path, "instances"))
    return await listInstances(runtime, request);
  if (method === "GET" && matches(path, "fleet", "status")) {
    await requireOwner(runtime, request);
    const status = await collectFleetStatus(runtime, request.signal);
    await requireOwner(runtime, request);
    return Response.json(status);
  }
  if (method === "POST" && matches(path, "fleet", "sessions")) {
    await requireMutation(runtime, request);
    const input = await parseJson(
      request,
      fleetSessionRequestSchema,
      400,
      "Session request is invalid.",
      maximumFleetSessionRequestBodyBytes,
    );
    return Response.json(await openFleetSession(runtime, request, input), {
      status: 201,
    });
  }
  if (method === "DELETE" && path[0] === "instances" && path.length === 2) {
    return await revokeInstance(runtime, request, path[1] ?? "");
  }
  if (
    method === "GET" &&
    path[0] === "instances" &&
    path[1] &&
    path[2] === "product" &&
    path[3] === "speech" &&
    path[4] === "assets" &&
    path[5] &&
    path.length === 6
  ) {
    return streamSpeechAudio(runtime, request, path[1], path[5]);
  }
  if (
    path[0] === "instances" &&
    path[2] === "product" &&
    path.length === 4 &&
    path[1]
  ) {
    if (method === "GET" && path[3] === "snapshot") {
      return await instanceProductSnapshot(runtime, request, path[1]);
    }
    if (
      method === "POST" &&
      path[3] &&
      Object.hasOwn(productOperationSchemas, path[3])
    ) {
      await requireMutation(runtime, request);
      await requireManagedInstance(runtime, path[1]);
      const operation = path[3] as keyof typeof productOperationSchemas;
      const input = await parseJson(
        request,
        productOperationSchemas[operation],
        400,
        "Operation request is invalid.",
        operation === "workspace"
          ? maximumWorkspaceRequestBodyBytes
          : operation === "deviceSettings"
            ? maximumDeviceSettingsRequestBodyBytes
            : maximumMediaRequestBodyBytes,
      );
      await requireMutation(runtime, request);
      await requireManagedInstance(runtime, path[1]);
      const capability = productOperationCapabilities[operation];
      if (
        capability &&
        !runtime.gateways.supportsCapability(path[1], capability.capability) &&
        !(
          operation === "workspace" &&
          runtime.gateways.supportsCapability(
            path[1],
            workspaceLibraryCapability,
          )
        )
      )
        throw new HttpError(409, capability.message);
      const response = await relay(
        runtime,
        path[1],
        hostRequestSchema.parse({
          type: operation,
          request:
            operation === "speech"
              ? scopeSpeechRequest(
                  speechRequestSchema.parse(input),
                  (await requireOwner(runtime, request)).sessionHash,
                  path[1],
                )
              : input,
        }),
        request.signal,
      );
      await requireOwner(runtime, request);
      await requireManagedInstance(runtime, path[1]);
      if (response.type === "error") throwHostError(response);
      if (response.type !== operation || !("response" in response))
        throw new HttpError(
          502,
          "Instance returned an invalid operation response.",
        );
      return Response.json(response.response);
    }
    if (method === "POST" && path[3] === "commands") {
      return await executeInstanceProductCommand(runtime, request, path[1]);
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
    const session = await requireOwner(runtime, request);
    await requireManagedInstance(runtime, path[1]);
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
        ? await requireOwner(runtime, request)
        : await requireMutation(runtime, request);
    await requireManagedInstance(runtime, instanceId);
    const previews = getPreviewHub(runtime);
    if (path[2] === "previews") {
      if (method === "POST") {
        const input = await parseJson(request, previewOpenSchema);
        await requireMutation(runtime, request);
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
          "Services are unavailable on this client. Update the client and start its Cloud service.",
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
        await requireOwner(runtime, request);
        await requireManagedInstance(runtime, instanceId);
        if (result.type === "error") throwHostError(result);
        if (result.type !== "workspaceRuns")
          throw new HttpError(502, "Invalid service status.");
        return Response.json({
          snapshot: result.snapshot,
          previewsEnabled: previews.enabled,
          previews: await previews.list(instanceId),
        });
      }
      if (method === "POST") {
        const command = await parseJson(request, runCommandSchema);
        await requireMutation(runtime, request);
        const result = await relay(
          runtime,
          instanceId,
          { type: "executeWorkspaceRun", workspace, command },
          request.signal,
        );
        if (result.type === "error") throwHostError(result);
        if (result.type !== "commandAccepted")
          throw new HttpError(502, "Invalid service command receipt.");
        await runtime.database.audit(
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
    return await settingsApi(runtime, request, path.slice(1));
  if (
    method === "GET" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path[2] &&
    path[3] === "enrollment" &&
    path.length === 4
  ) {
    await authenticateSettingsInstance(runtime, request, path[2]);
    return Response.json({
      captureRequired:
        runtime.settingsCipher !== null &&
        !(await runtime.database.get(
          "SELECT instance_id FROM enrollment_settings WHERE instance_id = $1",
          path[2],
        )),
    });
  }
  if (
    method === "PUT" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path[2] &&
    path[3] === "enrollment" &&
    path.length === 4
  ) {
    await authenticateSettingsInstance(runtime, request, path[2]);
    if (!runtime.settingsCipher) return new Response(null, { status: 204 });
    const input = await parseJson(
      request,
      z.unknown(),
      400,
      "Settings document is invalid.",
      runtime.config.settingsManager.limits.maximumDocumentBytes,
    );
    await authenticateSettingsInstance(runtime, request, path[2]);
    const document = validateSettingsDocument(
      input,
      runtime.config.settingsManager.limits,
    );
    await captureEnrollmentSettings(
      runtime.database,
      runtime.settingsCipher!,
      path[2],
      document,
      nowSeconds(),
    );
    return new Response(null, { status: 204 });
  }
  if (
    method === "GET" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path.length === 3
  ) {
    return await deliverSettings(runtime, request, path[2] ?? "");
  }
  if (
    method === "PUT" &&
    path[0] === "client" &&
    path[1] === "settings" &&
    path[2] &&
    path[3] === "sync-status" &&
    path.length === 4
  ) {
    return await reportSettingsSync(runtime, request, path[2]);
  }
  if (path[0] === "gateway" && path[1] === "connect") {
    throw new HttpError(426, "WebSocket upgrade is required.");
  }
  throw new HttpError(404, "Route was not found.");
}

async function createEnrollmentKey(
  runtime: FleetRuntime,
  request: Request,
): Promise<Response> {
  await requireMutation(runtime, request);
  const enrollmentKey = createSecret("mch_enroll");
  let grant: EnrollmentGrant;
  try {
    grant = await runtime.fleetStore.createEnrollmentGrant(
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
    managerId: await runtime.database.managerId(),
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
    throw new HttpError(
      400,
      "Gateway protocol version is incompatible. Update Machdoch and machdoch.cloud to matching versions, then enroll again.",
    );
  }
  let instanceId: string;
  try {
    instanceId = (
      await runtime.fleetStore.enrollInstance(
        {
          enrollmentKey,
          instanceSecret: input.instanceSecret,
          displayName,
          productVersion,
          protocolVersion: input.protocolVersion,
        },
        nowSeconds(),
      )
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
    managerId: await runtime.database.managerId(),
    managerUrl: runtime.config.externalBaseUrl,
    instanceId,
  });
}

async function listInstances(
  runtime: FleetRuntime,
  request: Request,
): Promise<Response> {
  await requireOwner(runtime, request);
  return Response.json({
    instances: (await runtime.fleetStore.listInstances()).map(
      ({ revokedAt, ...instance }) => ({
        ...instance,
        managerVersion: packageJson.version,
        versionStatus: productVersionStatus(
          instance.productVersion,
          packageJson.version,
          instance.protocolVersion,
          gatewayProtocolVersion,
        ),
        status:
          revokedAt !== null
            ? "revoked"
            : runtime.gateways.isOnline(instance.instanceId)
              ? "online"
              : "offline",
      }),
    ),
  });
}

async function revokeInstance(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<Response> {
  await requireMutation(runtime, request);
  if (!(await runtime.fleetStore.revokeInstance(instanceId, nowSeconds()))) {
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
  await requireOwner(runtime, request);
  await requireManagedInstance(runtime, instanceId);
  const response = await relay(
    runtime,
    instanceId,
    {
      type: "getProductSnapshot",
    },
    request.signal,
  );
  await requireOwner(runtime, request);
  await requireManagedInstance(runtime, instanceId);
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
  await requireMutation(runtime, request);
  await requireManagedInstance(runtime, instanceId);
  const input = await parseJson(request, productCommandSchema);
  const command = {
    ...input,
    commandId: input.commandId ?? createId("command"),
  };
  await requireMutation(runtime, request);
  await requireManagedInstance(runtime, instanceId);
  const response = await relay(
    runtime,
    instanceId,
    {
      type: "executeProductCommand",
      command,
    },
    request.signal,
  );
  await requireOwner(runtime, request);
  await requireManagedInstance(runtime, instanceId);
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
  if (matches(path, "delivery") && request.method === "PUT") {
    await requireMutation(runtime, request);
    const { enabled } = await parseJson(
      request,
      z.strictObject({ enabled: z.boolean() }),
    );
    await requireMutation(runtime, request);
    await runtime.settingsStore.setDeliveryEnabled(enabled, nowSeconds());
    return Response.json({ enabled });
  }
  requireSettings(runtime);
  try {
    if (request.method === "GET" && matches(path, "enrollment")) {
      await requireOwner(runtime, request);
      return Response.json({
        devices: await listEnrollmentSettings(runtime.database),
      });
    }
    if (
      request.method === "GET" &&
      path[0] === "instances" &&
      path[1] &&
      path[2] === "enrollment" &&
      path.length === 3
    ) {
      await requireOwner(runtime, request);
      await requireManagedInstance(runtime, path[1]);
      const document = await readEnrollmentSettings(
        runtime.database,
        runtime.settingsCipher!,
        path[1],
        runtime.config.settingsManager.limits,
      );
      if (!document)
        throw new HttpError(
          404,
          "Device settings have not been captured. Connect the device and retry.",
        );
      return Response.json({ document });
    }
    if (request.method === "GET" && matches(path, "catalog")) {
      await requireOwner(runtime, request);
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
      await requireOwner(runtime, request);
      return Response.json({
        profiles: await runtime.settingsStore.listProfiles(),
      });
    }
    if (request.method === "POST" && matches(path, "profiles")) {
      await requireMutation(runtime, request);
      const input = await parseJson(request, createProfileSchema);
      await requireMutation(runtime, request);
      const name = normalizeProfileName(input.name);
      const description = normalizeProfileDescription(input.description);
      const document = emptySettingsDocument();
      const profileId = await runtime.settingsStore.createProfile(
        name,
        description,
        document,
        nowSeconds(),
        runtime.config.settingsManager.limits.maximumProfiles,
      );
      return Response.json({
        profile: await runtime.settingsStore.getProfile(profileId),
      });
    }
    const profileId = path[1];
    if (path[0] === "profiles" && profileId) {
      validateProfileId(profileId);
      if (request.method === "GET" && path.length === 2) {
        await requireOwner(runtime, request);
        return Response.json({
          profile: await runtime.settingsStore.getProfile(profileId),
        });
      }
      if (request.method === "PUT" && path.length === 2) {
        await requireMutation(runtime, request);
        const input = await parseJson(request, updateProfileSchema);
        await requireMutation(runtime, request);
        await runtime.settingsStore.updateProfile(
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
          profile: await runtime.settingsStore.getProfile(profileId),
        });
      }
      if (request.method === "DELETE" && path.length === 2) {
        await requireMutation(runtime, request);
        await runtime.settingsStore.deleteProfile(profileId, nowSeconds());
        return Response.json({ ok: true });
      }
      if (
        request.method === "GET" &&
        path[2] === "versions" &&
        path.length === 3
      ) {
        await requireOwner(runtime, request);
        return Response.json({
          versions: await runtime.settingsStore.listVersions(profileId),
        });
      }
      if (
        request.method === "POST" &&
        path[2] === "versions" &&
        path[4] === "restore"
      ) {
        await requireMutation(runtime, request);
        const revision = Number(path[3]);
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new HttpError(404, "Revision was not found.");
        const input = await parseJson(request, expectedRevisionSchema);
        await requireMutation(runtime, request);
        await runtime.settingsStore.restoreVersion(
          profileId,
          revision,
          input.expectedRevision,
          nowSeconds(),
          runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
        );
        return Response.json({
          profile: await runtime.settingsStore.getProfile(profileId),
        });
      }
      if (path[2] === "secrets" && path[3] && path.length === 4) {
        const secretId = path[3];
        if (!isSecretId(secretId))
          throw new HttpError(404, "Secret type was not found.");
        await requireMutation(runtime, request);
        if (request.method === "PUT") {
          const input = await parseJson(request, secretSchema);
          await requireMutation(runtime, request);
          await runtime.settingsStore.setSecret(
            runtime.settingsCipher!,
            profileId,
            secretId,
            normalizeSecret(input.value, runtime.config.settingsManager.limits),
            input.expectedRevision,
            nowSeconds(),
            runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
          );
          return Response.json({
            profile: await runtime.settingsStore.getProfile(profileId),
          });
        }
        if (request.method === "DELETE") {
          const input = await parseJson(request, expectedRevisionSchema);
          await requireMutation(runtime, request);
          await runtime.settingsStore.deleteSecret(
            profileId,
            secretId,
            input.expectedRevision,
            nowSeconds(),
            runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
          );
          return Response.json({
            profile: await runtime.settingsStore.getProfile(profileId),
          });
        }
      }
    }
    if (request.method === "GET" && matches(path, "assignments")) {
      await requireOwner(runtime, request);
      return Response.json({
        assignments: (await runtime.settingsStore.listAssignments()).map(
          (assignment) => ({
            ...assignment,
            instanceStatus:
              assignment.instanceStatus === "revoked"
                ? "revoked"
                : runtime.gateways.isOnline(assignment.instanceId)
                  ? "online"
                  : "offline",
          }),
        ),
      });
    }
    if (
      request.method === "PUT" &&
      path[0] === "instances" &&
      path[1] &&
      path[2] === "assignment" &&
      path.length === 3
    ) {
      await requireMutation(runtime, request);
      const input = await parseJson(request, assignmentSchema);
      await requireMutation(runtime, request);
      await runtime.settingsStore.setAssignment(
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

async function deliverSettings(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<Response> {
  await authenticateSettingsInstance(runtime, request, instanceId);
  const managerId = await runtime.database.managerId();
  const identity = runtime.settingsCipher
    ? await runtime.settingsStore.getDeliveryIdentity(instanceId)
    : null;
  const candidateEtag = createFleetManagedSettingsEtag({
    managerId,
    profile: identity,
  });
  if (etagMatches(request.headers.get("If-None-Match"), candidateEtag)) {
    await authenticateSettingsInstance(runtime, request, instanceId);
    return new Response(null, {
      status: 304,
      headers: { ETag: candidateEtag },
    });
  }
  const delivery = runtime.settingsCipher
    ? await runtime.settingsStore.getDelivery(
        runtime.settingsCipher,
        instanceId,
      )
    : null;
  const response: FleetManagedSettingsDelivery = {
    schemaVersion: managedSettingsSchemaVersion,
    managerId,
    profile: delivery,
  };
  await authenticateSettingsInstance(runtime, request, instanceId);
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
  await authenticateSettingsInstance(runtime, request, instanceId);
  const input: FleetManagedSettingsSyncReport = await parseJson(
    request,
    settingsSyncReportSchema,
    400,
    "Request payload is invalid.",
    maximumSettingsSyncReportBodyBytes,
  );
  await authenticateSettingsInstance(runtime, request, instanceId);
  if (input.managerId !== (await runtime.database.managerId())) {
    throw new HttpError(
      409,
      "Settings assignment changed during synchronization.",
    );
  }
  if (
    !runtime.settingsCipher ||
    !(await runtime.settingsStore.deliveryEnabled())
  ) {
    if (input.profileId !== null || input.revision !== null) {
      throw new HttpError(
        409,
        "Settings assignment changed during synchronization.",
      );
    }
    return new Response(null, { status: 204 });
  }
  const now = nowSeconds();
  if (input.status === "failed") {
    if (
      !(await runtime.settingsStore.recordFailure(
        instanceId,
        input.profileId,
        input.revision,
        input.error,
        now,
      ))
    ) {
      throw new HttpError(
        409,
        "Settings assignment changed during synchronization.",
      );
    }
  } else {
    if (
      !(await runtime.settingsStore.recordApplied(
        instanceId,
        input.profileId,
        input.revision,
        now,
      ))
    ) {
      throw new HttpError(
        409,
        "Settings assignment changed during synchronization.",
      );
    }
  }
  return new Response(null, { status: 204 });
}

async function authenticateSettingsInstance(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
): Promise<void> {
  const secret = bearerToken(request);
  if (
    !validateId(instanceId, "instance") ||
    !secret ||
    !validateSecret(secret, "mch_instance") ||
    !(await runtime.fleetStore.authenticateInstance(instanceId, secret))
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
