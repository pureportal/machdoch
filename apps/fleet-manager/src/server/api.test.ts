import { randomBytes } from "node:crypto";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "./auth-store";
import { AuthenticationRateLimiter } from "./authentication-rate-limiter";
import { handleApiRequest } from "./api";
import type { FleetManagerConfig } from "./config";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";
import { setRuntimeForTests, type FleetRuntime } from "./runtime";
import { SettingsCipher, verifySettingsCipher } from "./settings-crypto";
import { SettingsStore } from "./settings-store";
import { emptySettingsDocument } from "./settings";

let runtime: FleetRuntime | null = null;

afterEach(() => {
  setRuntimeForTests(undefined);
  runtime?.gateways.close();
  runtime?.database.close();
  runtime = null;
});

describe("Fleet Manager API", () => {
  it("covers login, enrollment, registry, settings, assignment, and delivery", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    runtime.authStore.seedOwner(
      "owner",
      "a secure test password",
      nowSeconds(),
    );

    const login = await apiRequest("/api/auth/login", "POST", {
      username: "owner",
      password: "a secure test password",
    });
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie();
    const cookieHeader = cookies
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
    const csrf = /^__Host-machdoch_fleet_csrf=([^;]+)/m.exec(
      cookies.join("\n"),
    )?.[1];
    expect(csrf).toBeTruthy();

    const session = await apiRequest(
      "/api/auth/session",
      "GET",
      undefined,
      cookieHeader,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      username: "owner",
      settingsManagerEnabled: true,
    });

    const grantResponse = await apiRequest(
      "/api/enrollment-keys",
      "POST",
      undefined,
      cookieHeader,
      csrf,
    );
    const grant = (await grantResponse.json()) as { enrollmentKey: string };
    const instanceSecret = createSecret("mch_instance");
    const enrollment = await handleApiRequest(
      new Request("https://fleet.example.test/api/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.enrollmentKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Workstation",
          instanceSecret,
          productVersion: "6.3.0",
          protocolVersion: gatewayProtocolVersion,
        }),
      }),
      { clientAddress: "198.51.100.10" },
    );
    expect(enrollment.status).toBe(200);
    const enrollmentBody = (await enrollment.json()) as { instanceId: string };

    const createProfile = await apiRequest(
      "/api/settings/profiles",
      "POST",
      { name: "Engineering", description: "" },
      cookieHeader,
      csrf,
    );
    const created = (await createProfile.json()) as {
      profile: SettingsProfileResponse;
    };
    created.profile.document.defaults.provider = "openai";
    created.profile.document.instructions.push({
      id: crypto.randomUUID(),
      name: "Standards",
      body: "Use the current architecture.",
      enabled: true,
      global: true,
      tags: [],
    });
    const updateProfile = await apiRequest(
      `/api/settings/profiles/${created.profile.profileId}`,
      "PUT",
      {
        expectedRevision: created.profile.revision,
        name: created.profile.name,
        description: created.profile.description,
        document: created.profile.document,
        changeSummary: "Added standards",
      },
      cookieHeader,
      csrf,
    );
    const updated = (await updateProfile.json()) as {
      profile: SettingsProfileResponse;
    };
    expect(updated.profile.revision).toBe(2);

    const staleUpdate = await apiRequest(
      `/api/settings/profiles/${created.profile.profileId}`,
      "PUT",
      {
        expectedRevision: created.profile.revision,
        name: created.profile.name,
        description: created.profile.description,
        document: created.profile.document,
        changeSummary: "Stale update",
      },
      cookieHeader,
      csrf,
    );
    expect(staleUpdate.status).toBe(409);

    const secretResponse = await apiRequest(
      `/api/settings/profiles/${updated.profile.profileId}/secrets/openai`,
      "PUT",
      { expectedRevision: updated.profile.revision, value: "sk-test-secret" },
      cookieHeader,
      csrf,
    );
    const secretProfile = (await secretResponse.json()) as {
      profile: SettingsProfileResponse;
    };
    expect(secretProfile.profile.secrets).toEqual([
      expect.objectContaining({ secretId: "openai", lastFour: "cret" }),
    ]);
    expect(JSON.stringify(secretProfile)).not.toContain("sk-test-secret");

    const assignment = await apiRequest(
      `/api/settings/instances/${enrollmentBody.instanceId}/assignment`,
      "PUT",
      { profileId: updated.profile.profileId },
      cookieHeader,
      csrf,
    );
    expect(assignment.status).toBe(200);

    const delivery = await handleApiRequest(
      new Request(
        `https://fleet.example.test/api/client/settings/${enrollmentBody.instanceId}`,
        { headers: { Authorization: `Bearer ${instanceSecret}` } },
      ),
      { clientAddress: "198.51.100.10" },
    );
    expect(delivery.status).toBe(200);
    const etag = delivery.headers.get("etag");
    expect(etag).toBeTruthy();
    const deliveryBody = (await delivery.json()) as {
      schemaVersion: number;
      managerId: string;
      profile: { profileId: string; revision: number; name: string };
    };
    expect(deliveryBody).toMatchObject({
      schemaVersion: 2,
      profile: {
        name: "Engineering",
        secrets: { openai: "sk-test-secret" },
      },
    });

    const pendingAssignments = await apiRequest(
      "/api/settings/assignments",
      "GET",
      undefined,
      cookieHeader,
    );
    expect(await pendingAssignments.json()).toMatchObject({
      assignments: [
        expect.objectContaining({
          lastAppliedRevision: null,
          syncStatus: "pending",
        }),
      ],
    });

    const decrypt = vi.spyOn(runtime.settingsCipher!, "decrypt");
    const unchanged = await handleApiRequest(
      new Request(
        `https://fleet.example.test/api/client/settings/${enrollmentBody.instanceId}`,
        {
          headers: {
            Authorization: `Bearer ${instanceSecret}`,
            "If-None-Match": etag ?? "",
          },
        },
      ),
      { clientAddress: "198.51.100.10" },
    );
    expect(unchanged.status).toBe(304);
    expect(decrypt).not.toHaveBeenCalled();
    decrypt.mockRestore();

    const failedSync = await handleApiRequest(
      new Request(
        `https://fleet.example.test/api/client/settings/${enrollmentBody.instanceId}/sync-status`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${instanceSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            managerId: deliveryBody.managerId,
            status: "failed",
            profileId: deliveryBody.profile.profileId,
            revision: deliveryBody.profile.revision,
            error: "Managed prompt could not be written.",
          }),
        },
      ),
      { clientAddress: "198.51.100.10" },
    );
    expect(failedSync.status).toBe(204);

    const failedAssignments = await apiRequest(
      "/api/settings/assignments",
      "GET",
      undefined,
      cookieHeader,
    );
    expect(await failedAssignments.json()).toMatchObject({
      assignments: [
        expect.objectContaining({
          syncStatus: "failed",
          lastSyncRevision: deliveryBody.profile.revision,
          lastSyncAttemptAt: expect.any(Number),
          syncError: "Managed prompt could not be written.",
        }),
      ],
    });

    const staleApplication = await handleApiRequest(
      new Request(
        `https://fleet.example.test/api/client/settings/${enrollmentBody.instanceId}/sync-status`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${instanceSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            managerId: deliveryBody.managerId,
            status: "applied",
            profileId: deliveryBody.profile.profileId,
            revision: deliveryBody.profile.revision - 1,
          }),
        },
      ),
      { clientAddress: "198.51.100.10" },
    );
    expect(staleApplication.status).toBe(409);

    const applied = await handleApiRequest(
      new Request(
        `https://fleet.example.test/api/client/settings/${enrollmentBody.instanceId}/sync-status`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${instanceSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            managerId: deliveryBody.managerId,
            status: "applied",
            profileId: deliveryBody.profile.profileId,
            revision: deliveryBody.profile.revision,
          }),
        },
      ),
      { clientAddress: "198.51.100.10" },
    );
    expect(applied.status).toBe(204);

    const assignmentsResponse = await apiRequest(
      "/api/settings/assignments",
      "GET",
      undefined,
      cookieHeader,
    );
    expect(await assignmentsResponse.json()).toMatchObject({
      assignments: [
        expect.objectContaining({
          lastAppliedRevision: deliveryBody.profile.revision,
          syncStatus: "applied",
          syncError: null,
        }),
      ],
    });

    const instances = await apiRequest(
      "/api/instances",
      "GET",
      undefined,
      cookieHeader,
    );
    expect(await instances.json()).toMatchObject({
      instances: [
        expect.objectContaining({
          displayName: "Workstation",
          status: "offline",
        }),
      ],
    });
  });

  it("records client settings failures and clears them after application", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const now = nowSeconds();
    const enrollmentKey = createSecret("mch_enroll");
    const instanceSecret = createSecret("mch_instance");
    runtime.fleetStore.createEnrollmentGrant(
      enrollmentKey,
      now,
      runtime.config.enrollmentPolicy,
    );
    const instance = runtime.fleetStore.enrollInstance(
      {
        enrollmentKey,
        instanceSecret,
        displayName: "Sync client",
        productVersion: "7.0.6",
        protocolVersion: gatewayProtocolVersion,
      },
      now,
    );
    const profileId = runtime.settingsStore.createProfile(
      "Engineering",
      "",
      emptySettingsDocument(),
      now,
      runtime.config.settingsManager.limits.maximumProfiles,
    );
    runtime.settingsStore.setAssignment(instance.instanceId, profileId, now);
    const managerId = runtime.database.managerId();

    const failed = await clientSettingsStatusRequest(
      instance.instanceId,
      instanceSecret,
      {
        managerId,
        status: "failed",
        profileId,
        revision: 1,
        error: "Managed prompt could not be written.",
      },
    );

    expect(failed.status).toBe(204);
    expect(runtime.settingsStore.listAssignments()[0]).toMatchObject({
      syncStatus: "failed",
      lastSyncRevision: 1,
      syncError: "Managed prompt could not be written.",
    });

    const staleFailure = await clientSettingsStatusRequest(
      instance.instanceId,
      instanceSecret,
      {
        managerId,
        status: "failed",
        profileId,
        revision: 2,
        error: "This failure belongs to another revision.",
      },
    );
    expect(staleFailure.status).toBe(409);

    const unsafeFailure = await clientSettingsStatusRequest(
      instance.instanceId,
      instanceSecret,
      {
        managerId,
        status: "failed",
        profileId,
        revision: 1,
        error: "\u001b[31mspoofed",
      },
    );
    expect(unsafeFailure.status).toBe(400);

    const applied = await clientSettingsStatusRequest(
      instance.instanceId,
      instanceSecret,
      {
        managerId,
        status: "applied",
        profileId,
        revision: 1,
      },
    );

    expect(applied.status).toBe(204);
    expect(runtime.settingsStore.listAssignments()[0]).toMatchObject({
      syncStatus: "applied",
      lastAppliedRevision: 1,
      syncError: null,
    });

    const profile = runtime.settingsStore.getProfile(profileId);
    runtime.settingsStore.updateProfile(
      profileId,
      profile.revision,
      profile.name,
      profile.description,
      profile.document,
      "Changed profile",
      now + 1,
      runtime.config.settingsManager.limits.maximumRevisionsPerProfile,
    );

    expect(runtime.settingsStore.listAssignments()[0]).toMatchObject({
      profileRevision: 2,
      lastAppliedRevision: 1,
      syncStatus: "pending",
      syncError: null,
    });

    runtime.fleetStore.revokeInstance(instance.instanceId, now + 2);
    expect(
      runtime.settingsStore.recordFailure(
        instance.instanceId,
        profileId,
        2,
        "Late report",
        now + 2,
      ),
    ).toBe(false);
  });
});

interface SettingsProfileResponse {
  profileId: string;
  name: string;
  description: string;
  revision: number;
  document: {
    defaults: Record<string, string | null>;
    agentLimits: Record<string, number | boolean | null>;
    instructions: Array<Record<string, unknown>>;
    contextPacks: Array<Record<string, unknown>>;
    prompts: Array<Record<string, unknown>>;
  };
  secrets: Array<{ secretId: string; lastFour: string }>;
}

async function apiRequest(
  path: string,
  method: string,
  body?: unknown,
  cookie?: string,
  csrf?: string,
): Promise<Response> {
  const headers = new Headers({ Origin: "https://fleet.example.test" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (csrf) headers.set("X-Machdoch-Fleet-CSRF", csrf);
  return handleApiRequest(
    new Request(`https://fleet.example.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { clientAddress: "198.51.100.10" },
  );
}

async function clientSettingsStatusRequest(
  instanceId: string,
  instanceSecret: string,
  body: unknown,
): Promise<Response> {
  return handleApiRequest(
    new Request(
      `https://fleet.example.test/api/client/settings/${instanceId}/sync-status`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${instanceSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
    { clientAddress: "198.51.100.10" },
  );
}

function testRuntime(): FleetRuntime {
  const config: FleetManagerConfig = {
    schemaVersion: 1,
    externalBaseUrl: "https://fleet.example.test",
    listen: { address: "127.0.0.1", port: 43188 },
    database: { path: ":memory:" },
    sessionPolicy: {
      idleSeconds: 1800,
      absoluteSeconds: 43_200,
      maximumConcurrentSessions: 8,
    },
    enrollmentPolicy: { keyLifetimeSeconds: 900, maximumOutstandingKeys: 8 },
    connectionPolicy: { requestTimeoutSeconds: 1, heartbeatTimeoutSeconds: 45 },
    settingsManager: {
      enabled: true,
      encryptionKeyEnvironmentVariable: "TEST_KEY",
      limits: {
        maximumProfiles: 64,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumPromptsPerProfile: 128,
        maximumRevisionsPerProfile: 100,
        maximumDocumentBytes: 1024 * 1024,
        maximumSecretBytes: 8192,
      },
    },
  };
  const database = new FleetDatabase(":memory:");
  const authStore = new AuthStore(database);
  const fleetStore = new FleetStore(database);
  const settingsCipher = new SettingsCipher(randomBytes(32));
  verifySettingsCipher(database, settingsCipher);
  return {
    config,
    database,
    authStore,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher,
    gateways: new GatewayHub(config, fleetStore),
    authenticationRateLimiter: new AuthenticationRateLimiter(),
  };
}
