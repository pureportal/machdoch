import { randomBytes } from "node:crypto";
import {
  gatewayProtocolVersion,
  managedSettingsSchemaVersion,
} from "@machdoch/fleet-protocol";
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
  runtime?.previews?.close();
  runtime?.database.close();
  runtime = null;
});

describe("Fleet Manager API", () => {
  it("captures encrypted device settings once and only exposes them to the owner", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const device = enrollTestInstance(runtime);
    const capture = async (document: unknown, secret = device.instanceSecret) =>
      handleApiRequest(
        new Request(
          `https://fleet.example.test/api/client/settings/${device.instanceId}/enrollment`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(document),
          },
        ),
        { clientAddress: "198.51.100.10" },
      );
    const original = emptySettingsDocument();
    original.defaults.theme = "dark";
    expect((await capture(original, createSecret("mch_instance"))).status).toBe(
      401,
    );
    expect(
      (
        await capture({
          ...original,
          secrets: { openai: "never-capture-api-keys" },
        })
      ).status,
    ).toBe(400);
    expect((await capture(original)).status).toBe(204);
    expect(
      (
        await capture({
          ...original,
          defaults: { ...original.defaults, theme: "light" },
        })
      ).status,
    ).toBe(204);
    const row = runtime.database.get(
      "SELECT document_ciphertext FROM enrollment_settings WHERE instance_id = ?",
      device.instanceId,
    );
    expect(row!.document_ciphertext).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(row!.document_ciphertext as Uint8Array).toString("utf8"),
    ).not.toContain("dark");
    expect((await apiRequest("/api/settings/enrollment", "GET")).status).toBe(
      401,
    );
    const { cookie } = await authenticateTestOwner();
    const inventory = await apiRequest(
      "/api/settings/enrollment",
      "GET",
      undefined,
      cookie,
    );
    expect((await inventory.json()).devices).toMatchObject([
      { instanceId: device.instanceId },
    ]);
    const response = await apiRequest(
      `/api/settings/instances/${device.instanceId}/enrollment`,
      "GET",
      undefined,
      cookie,
    );
    expect((await response.json()).document.defaults.theme).toBe("dark");
    expect(runtime.settingsStore.listProfiles()).toEqual([]);
    runtime.fleetStore.revokeInstance(device.instanceId, nowSeconds());
    expect((await capture(original)).status).toBe(401);
    expect(
      (
        await apiRequest(
          `/api/settings/instances/${device.instanceId}/enrollment`,
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await (
          await apiRequest("/api/settings/enrollment", "GET", undefined, cookie)
        ).json()
      ).devices,
    ).toEqual([]);
  });

  it("cannot capture settings after instance revocation during body reading", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const device = enrollTestInstance(runtime);
    const request = new Request(
      `https://fleet.example.test/api/client/settings/${device.instanceId}/enrollment`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${device.instanceSecret}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    vi.spyOn(request, "text").mockImplementation(async () => {
      runtime!.fleetStore.revokeInstance(device.instanceId, nowSeconds());
      return JSON.stringify(emptySettingsDocument());
    });
    expect(
      (await handleApiRequest(request, { clientAddress: "198.51.100.10" }))
        .status,
    ).toBe(401);
    expect(
      runtime.database.all("SELECT instance_id FROM enrollment_settings"),
    ).toEqual([]);
  });
  it("rejects a settings sync report when the instance is revoked while reading its body", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { instanceId, instanceSecret } = enrollTestInstance(runtime);
    const body = {
      managerId: runtime.database.managerId(),
      status: "applied",
      profileId: null,
      revision: null,
    };
    const request = new Request(
      `https://fleet.example.test/api/client/settings/${instanceId}/sync-status`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${instanceSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    vi.spyOn(request, "text").mockImplementation(async () => {
      runtime!.fleetStore.revokeInstance(instanceId, nowSeconds());
      return JSON.stringify(body);
    });
    const recordApplied = vi.spyOn(runtime.settingsStore, "recordApplied");
    expect(
      (await handleApiRequest(request, { clientAddress: "198.51.100.10" }))
        .status,
    ).toBe(401);
    expect(recordApplied).not.toHaveBeenCalled();
  });
  it("rejects settings writes when the owner session is revoked while reading the body", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const request = new Request(
      "https://fleet.example.test/api/settings/profiles",
      {
        method: "POST",
        headers: {
          Origin: "https://fleet.example.test",
          Cookie: cookie,
          "X-Machdoch-Fleet-CSRF": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Engineering" }),
      },
    );
    vi.spyOn(request, "json").mockImplementation(async () => {
      runtime!.authStore.changeOwnerPassword(
        "owner",
        "a changed secure password",
        nowSeconds(),
      );
      return { name: "Engineering" };
    });
    const response = await handleApiRequest(request, {
      clientAddress: "198.51.100.10",
    });
    expect(response.status).toBe(401);
    expect(runtime.settingsStore.listProfiles()).toEqual([]);
  });
  it("authenticates fleet status and removes instances revoked during collection", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    expect((await apiRequest("/api/fleet/status", "GET")).status).toBe(401);
    const { cookie } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    vi.spyOn(runtime.gateways, "isOnline").mockReturnValue(true);
    vi.spyOn(runtime.gateways, "relay").mockImplementation(async () => {
      runtime!.fleetStore.revokeInstance(instance.instanceId, nowSeconds());
      return {
        type: "productSnapshot",
        snapshot: {
          enabled: true,
          serverTime: Date.now(),
          eventId: 0,
          sessions: [],
          commands: [],
        },
      };
    });
    const response = await apiRequest(
      "/api/fleet/status",
      "GET",
      undefined,
      cookie,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).devices).toEqual([]);
  });

  it("rechecks owner authentication after collecting fleet status", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie } = await authenticateTestOwner();
    enrollTestInstance(runtime);
    vi.spyOn(runtime.gateways, "isOnline").mockReturnValue(true);
    vi.spyOn(runtime.gateways, "relay").mockImplementation(async () => {
      runtime!.authStore.changeOwnerPassword(
        "owner",
        "a changed secure password",
        nowSeconds(),
      );
      return {
        type: "productSnapshot",
        snapshot: {
          enabled: true,
          serverTime: Date.now(),
          eventId: 0,
          sessions: [],
          commands: [],
        },
      };
    });
    expect(
      (await apiRequest("/api/fleet/status", "GET", undefined, cookie)).status,
    ).toBe(401);
  });

  it("delivers no managed settings when Settings Manager is disabled and preserves assignments", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const instance = enrollTestInstance(runtime);
    const cipher = runtime.settingsCipher!;
    const profileId = runtime.settingsStore.createProfile(
      "Engineering",
      "",
      emptySettingsDocument(),
      nowSeconds(),
      runtime.config.settingsManager.limits.maximumProfiles,
    );
    runtime.settingsStore.setAssignment(
      instance.instanceId,
      profileId,
      nowSeconds(),
    );
    const path = `/api/client/settings/${instance.instanceId}`;
    const requestSettings = (
      secret?: string,
      etag?: string,
    ): Promise<Response> => {
      const headers = new Headers();
      if (secret) headers.set("Authorization", `Bearer ${secret}`);
      if (etag) headers.set("If-None-Match", etag);
      return handleApiRequest(
        new Request(`https://fleet.example.test${path}`, { headers }),
        { clientAddress: "127.0.0.1" },
      );
    };
    const assigned = await requestSettings(instance.instanceSecret);
    const assignedEtag = assigned.headers.get("ETag")!;
    expect((await assigned.json()).profile.profileId).toBe(profileId);
    runtime.settingsCipher = null;
    runtime.config.settingsManager.enabled = false;
    expect((await requestSettings()).status).toBe(401);
    expect((await requestSettings(createSecret("mch_instance"))).status).toBe(
      401,
    );
    const delivery = await requestSettings(
      instance.instanceSecret,
      assignedEtag,
    );
    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toEqual({
      schemaVersion: managedSettingsSchemaVersion,
      managerId: runtime.database.managerId(),
      profile: null,
    });
    const disabledEtag = delivery.headers.get("ETag")!;
    expect(disabledEtag).not.toBe(assignedEtag);
    expect(
      (await requestSettings(instance.instanceSecret, disabledEtag)).status,
    ).toBe(304);
    expect(
      (
        await clientSettingsStatusRequest(
          instance.instanceId,
          instance.instanceSecret,
          {
            status: "applied",
            managerId: runtime.database.managerId(),
            profileId: null,
            revision: null,
          },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await clientSettingsStatusRequest(
          instance.instanceId,
          createSecret("mch_instance"),
          {
            status: "applied",
            managerId: runtime.database.managerId(),
            profileId: null,
            revision: null,
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await clientSettingsStatusRequest(
          instance.instanceId,
          instance.instanceSecret,
          {
            status: "applied",
            managerId: runtime.database.managerId(),
            profileId,
            revision: 1,
          },
        )
      ).status,
    ).toBe(409);
    expect((await apiRequest("/api/settings/profiles", "GET")).status).toBe(
      404,
    );
    expect(
      runtime.settingsStore.getDeliveryIdentity(instance.instanceId),
    ).toEqual({ profileId, revision: 1 });
    runtime.settingsCipher = cipher;
    runtime.config.settingsManager.enabled = true;
    const restored = await requestSettings(
      instance.instanceSecret,
      disabledEtag,
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).profile.profileId).toBe(profileId);
    runtime.fleetStore.revokeInstance(instance.instanceId, nowSeconds());
    runtime.settingsCipher = null;
    expect((await requestSettings(instance.instanceSecret)).status).toBe(401);
  });

  it("protects media operations with owner authentication, CSRF, and the media allowlist", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    const path = `/api/instances/${instance.instanceId}/product/media`;
    const request = {
      kind: "invoke",
      id: crypto.randomUUID(),
      command: "media_search_civitai",
      args: { request: { query: "Age" } },
    };
    expect((await apiRequest(path, "POST", request)).status).toBe(401);
    expect((await apiRequest(path, "POST", request, cookie)).status).toBe(403);
    expect(
      (
        await apiRequest(
          path,
          "POST",
          { ...request, command: "execute_shell" },
          cookie,
          csrf,
        )
      ).status,
    ).toBe(400);
    const relay = vi
      .spyOn(runtime.gateways, "relay")
      .mockResolvedValue({ type: "media", response: { state: "pending" } });
    const response = await apiRequest(path, "POST", request, cookie, csrf);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "pending" });
    expect(relay).toHaveBeenCalledWith(
      instance.instanceId,
      { type: "media", request },
      expect.any(AbortSignal),
    );
    const upload = {
      kind: "invoke",
      id: crypto.randomUUID(),
      command: "media_write_transfer",
      args: { id: crypto.randomUUID(), offset: 0, data: "A".repeat(524288) },
    };
    expect((await apiRequest(path, "POST", upload, cookie, csrf)).status).toBe(
      200,
    );
    const assistant = {
      kind: "invoke",
      id: crypto.randomUUID(),
      command: "run_media_flow_agent",
      args: {
        workspaceRoot: "C:\\work",
        request: {
          prompt: "Add an output",
          messages: Array.from({ length: 40 }, () => ({
            role: "user",
            content: "A".repeat(28_000),
          })),
        },
      },
    };
    expect(
      (await apiRequest(path, "POST", assistant, cookie, csrf)).status,
    ).toBe(200);
    const oversized = {
      ...upload,
      args: { ...upload.args, data: "A".repeat(2_250_000) },
    };
    const calls = relay.mock.calls.length;
    expect(
      (await apiRequest(path, "POST", oversized, cookie, csrf)).status,
    ).toBe(413);
    expect(relay.mock.calls).toHaveLength(calls);
  });
  it("requires owner CSRF for service mutations and preview grants and gates unsupported hosts", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    const base = `/api/instances/${instance.instanceId}`;
    expect(
      (await apiRequest(`${base}/runs?workspace=/project`, "GET")).status,
    ).toBe(401);
    expect(
      (await apiRequest(`${base}/runs?workspace=/project`, "POST", {}, cookie))
        .status,
    ).toBe(403);
    expect(
      (await apiRequest(`${base}/previews`, "POST", {}, cookie)).status,
    ).toBe(403);
    expect(
      (await apiRequest(`${base}/previews`, "DELETE", undefined, cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await apiRequest(
          `${base}/runs?workspace=/project`,
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(503);
    expect(
      (await apiRequest(`${base}/previews`, "DELETE", undefined, cookie, csrf))
        .status,
    ).toBe(200);
  });
  it("protects enrollment-key inventory and revocation with owner authentication and CSRF", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const created = await apiRequest(
      "/api/enrollment-keys",
      "POST",
      undefined,
      cookie,
      csrf,
    );
    const grant = (await created.json()) as {
      grantId: string;
      enrollmentKey: string;
      expiresAt: number;
    };
    expect(grant.grantId).toMatch(/^grant_/u);
    expect((await apiRequest("/api/enrollment-keys", "GET")).status).toBe(401);
    const inventory = await apiRequest(
      "/api/enrollment-keys",
      "GET",
      undefined,
      cookie,
    );
    const body = (await inventory.json()) as { grants: unknown[] };
    expect(body.grants).toEqual([
      expect.objectContaining({
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(grant.enrollmentKey);
    const path = `/api/enrollment-keys/${grant.grantId}`;
    expect((await apiRequest(path, "DELETE", undefined, cookie)).status).toBe(
      403,
    );
    const crossOrigin = await handleApiRequest(
      new Request(`https://fleet.example.test${path}`, {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: "https://attacker.example",
          "X-Machdoch-Fleet-CSRF": csrf,
        },
      }),
      { clientAddress: "198.51.100.10" },
    );
    expect(crossOrigin.status).toBe(403);
    expect(runtime.fleetStore.listEnrollmentGrants(nowSeconds())).toHaveLength(
      1,
    );
    expect(
      (await apiRequest(path, "DELETE", undefined, cookie, csrf)).status,
    ).toBe(200);
    expect(
      (await apiRequest(path, "DELETE", undefined, cookie, csrf)).status,
    ).toBe(404);
    expect(runtime.fleetStore.listEnrollmentGrants(nowSeconds())).toEqual([]);
    const enrollment = await handleApiRequest(
      new Request("https://fleet.example.test/api/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.enrollmentKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instanceSecret: createSecret("mch_instance"),
          displayName: "Intruder",
          productVersion: "7.0.6",
          protocolVersion: gatewayProtocolVersion,
        }),
      }),
      { clientAddress: "198.51.100.10" },
    );
    expect(enrollment.status).toBe(401);
  });

  it("rechecks revoked authorization before delivering an in-flight snapshot", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    vi.spyOn(runtime.gateways, "relay").mockImplementation(async () => {
      runtime!.authStore.changeOwnerPassword(
        "owner",
        "a changed secure test password",
        nowSeconds(),
      );
      return {
        type: "productSnapshot",
        snapshot: {
          enabled: true,
          serverTime: 1,
          eventId: 1,
          sessions: [],
          commands: [],
        },
      };
    });
    const response = await apiRequest(
      `/api/instances/${instance.instanceId}/product/snapshot`,
      "GET",
      undefined,
      cookie,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("sessions");
  });

  it("does not dispatch a command after the session is revoked while its body is being read", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    const relay = vi.spyOn(runtime.gateways, "relay");
    const request = new Request(
      `https://fleet.example.test/api/instances/${instance.instanceId}/product/commands`,
      {
        method: "POST",
        headers: {
          Origin: "https://fleet.example.test",
          Cookie: cookie,
          "X-Machdoch-Fleet-CSRF": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    vi.spyOn(request, "json").mockImplementation(async () => {
      runtime!.authStore.changeOwnerPassword(
        "owner",
        "a changed secure test password",
        nowSeconds(),
      );
      return { kind: "cancel", commandId: "command-1", taskId: "task-1" };
    });
    const response = await handleApiRequest(request, {
      clientAddress: "198.51.100.10",
    });
    expect(response.status).toBe(401);
    expect(relay).not.toHaveBeenCalled();
  });

  it("assigns missing command IDs and refuses a receipt for a different command", async () => {
    runtime = testRuntime();
    setRuntimeForTests(runtime);
    const { cookie, csrf } = await authenticateTestOwner();
    const instance = enrollTestInstance(runtime);
    const relayed = vi
      .spyOn(runtime.gateways, "relay")
      .mockImplementation(async (_instanceId, request) => {
        if (request.type !== "executeProductCommand")
          throw new Error("Expected a command.");
        expect(request.command.commandId).toMatch(/^command_/u);
        return {
          type: "commandAccepted",
          receipt: { commandId: request.command.commandId!, duplicate: false },
        };
      });
    const path = `/api/instances/${instance.instanceId}/product/commands`;
    expect(
      (
        await apiRequest(
          path,
          "POST",
          { kind: "cancel", taskId: "task-1" },
          cookie,
          csrf,
        )
      ).status,
    ).toBe(202);
    relayed.mockResolvedValue({
      type: "commandAccepted",
      receipt: { commandId: "other-command", duplicate: false },
    });
    expect(
      (
        await apiRequest(
          path,
          "POST",
          { kind: "cancel", taskId: "task-1", commandId: "command-1" },
          cookie,
          csrf,
        )
      ).status,
    ).toBe(502);
  });
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

async function authenticateTestOwner(): Promise<{
  cookie: string;
  csrf: string;
}> {
  runtime!.authStore.seedOwner("owner", "a secure test password", nowSeconds());
  const response = await apiRequest("/api/auth/login", "POST", {
    username: "owner",
    password: "a secure test password",
  });
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = /^__Host-machdoch_fleet_csrf=([^;]+)/mu.exec(
    cookies.join("\n"),
  )?.[1];
  if (!csrf) throw new Error("Missing test CSRF cookie.");
  return { cookie, csrf };
}

function enrollTestInstance(runtime: FleetRuntime) {
  const enrollmentKey = createSecret("mch_enroll");
  const instanceSecret = createSecret("mch_instance");
  runtime.fleetStore.createEnrollmentGrant(
    enrollmentKey,
    nowSeconds(),
    runtime.config.enrollmentPolicy,
  );
  const instance = runtime.fleetStore.enrollInstance(
    {
      enrollmentKey,
      instanceSecret,
      displayName: "Test",
      productVersion: "7.0.6",
      protocolVersion: gatewayProtocolVersion,
    },
    nowSeconds(),
  );
  return { ...instance, instanceSecret };
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
