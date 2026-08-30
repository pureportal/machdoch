import { randomBytes } from "node:crypto";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store";
import { handleApiRequest } from "./api";
import type { FleetManagerConfig } from "./config";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";
import { LoginThrottle } from "./login-throttle";
import { setRuntimeForTests, type FleetRuntime } from "./runtime";
import { SettingsCipher, verifySettingsCipher } from "./settings-crypto";
import { SettingsStore } from "./settings-store";

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
    runtime.authStore.seedOwner("owner", "password", nowSeconds());

    const login = await apiRequest("/api/auth/login", "POST", {
      username: "owner",
      password: "password",
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
    );
    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toMatchObject({
      assigned: true,
      profile: {
        name: "Engineering",
        secrets: { openai: "sk-test-secret" },
      },
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
    customValues: Record<string, unknown>;
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
    loginThrottle: new LoginThrottle(),
  };
}
