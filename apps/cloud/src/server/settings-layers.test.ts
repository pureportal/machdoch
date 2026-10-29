import {
  gatewayProtocolVersion,
  type FleetManagedSettingsDelivery,
} from "@machdoch/fleet-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRemoteTestRuntime } from "../test/remote-fixture";
import { handleApiRequest } from "./api";
import { createSecret } from "./crypto";
import { nowSeconds } from "./database";
import { setRuntimeForTests, type FleetRuntime } from "./runtime";
import { emptySettingsDocument } from "./settings";

let runtime: FleetRuntime;
beforeEach(async () => {
  runtime = await createRemoteTestRuntime();
  setRuntimeForTests(runtime);
}, 120_000);

afterEach(async () => {
  setRuntimeForTests(undefined);
  runtime.gateways.close();
  runtime.previews?.close();
  await runtime.database.close();
});

const origin = "https://fleet.example.test";
const instruction = (id: string, name: string, body: string) => ({
  id,
  name,
  body,
  enabled: true,
  global: true,
  tags: [],
});
const uuid = (suffix: number) =>
  `123e4567-e89b-42d3-a456-4266141740${String(suffix).padStart(2, "0")}`;

describe("layered managed settings", () => {
  it("composes stacked profiles for v3 clients and keeps v2 clients on the first layer", async () => {
    const device = await enroll();
    const owner = await login();
    const team = await createProfile(owner, "Team", (document) => {
      document.defaults.provider = "anthropic";
      document.defaults.model = "claude-opus-5-5";
      document.defaults.theme = "light";
      document.instructions = [instruction(uuid(1), "Code style", "Team")];
      document.mcpServers = [
        {
          id: "github",
          title: "GitHub",
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["server-github"],
            env: { GITHUB_TOKEN: "{{secret:mcp_github}}" },
          },
        },
      ];
    });
    const baseline = await createProfile(owner, "Baseline", (document) => {
      document.defaults.provider = "openai";
      document.defaults.model = "gpt-5.6";
      document.defaults.mode = "ask";
      document.policy = { enforced: ["model"] };
      document.instructions = [
        instruction(uuid(2), "code style", "Base"),
        instruction(uuid(3), "Security", "Safe"),
      ];
    });
    await setSecret(owner, team.profileId, "mcp_github", "gh-token");
    await setSecret(owner, team.profileId, "openai", "team-key");

    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [team.profileId, team.profileId],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [team.profileId, baseline.profileId],
        })
      ).status,
    ).toBe(200);

    const current = await fetchDelivery(device, 3);
    expect(current.status).toBe(200);
    const layered = (await current.json()) as FleetManagedSettingsDelivery;
    expect(layered.schemaVersion).toBe(3);
    expect(layered.layers?.map((layer) => layer.name)).toEqual([
      "Team",
      "Baseline",
    ]);
    expect(layered.profile).toMatchObject({
      profileId: team.profileId,
      name: "Team + Baseline",
      secrets: { mcp_github: "gh-token", openai: "team-key" },
    });
    expect(layered.profile?.document.defaults).toMatchObject({
      provider: "openai",
      model: "gpt-5.6",
      mode: "ask",
      theme: "light",
    });
    expect(layered.profile?.document.policy?.enforced).toEqual(["model"]);
    expect(
      layered.profile?.document.instructions.map((item) => item.body),
    ).toEqual(["Team", "Safe"]);
    const etag = current.headers.get("ETag")!;
    expect(etag).toContain("managed-settings.v3.");
    expect((await fetchDelivery(device, 3, etag)).status).toBe(304);
    const newer = await fetchDelivery(device, 4, etag);
    expect(newer.status).toBe(304);
    expect(newer.headers.get("ETag")).toBe(etag);

    const legacy = (await (
      await fetchDelivery(device)
    ).json()) as FleetManagedSettingsDelivery;
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.layers).toBeUndefined();
    expect(legacy.profile?.name).toBe("Team");
    expect(legacy.profile?.secrets).toEqual({ openai: "team-key" });
    expect(legacy.profile?.document.policy).toBeUndefined();
    expect(legacy.profile?.document.mcpServers).toBeUndefined();

    const layers = layered.layers!.map(({ profileId, revision }) => ({
      profileId,
      revision,
    }));
    const report = (body: Record<string, unknown>) =>
      deviceRequest(device, "sync-status", "PUT", {
        managerId: layered.managerId,
        profileId: team.profileId,
        revision: layers[0]!.revision,
        ...body,
      });
    expect(
      (
        await report({
          status: "applied",
          layers: [layers[0]],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await report({
          status: "applied",
          layers,
          warnings: ["Your local 'Code style' is hidden while managed."],
        })
      ).status,
    ).toBe(204);
    let [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "applied",
      warnings: ["Your local 'Code style' is hidden while managed."],
      layers: [
        { profileId: team.profileId, position: 0, syncStatus: "applied" },
        { profileId: baseline.profileId, position: 1, syncStatus: "applied" },
      ],
    });
    expect(
      (await report({ status: "failed", layers, error: "Disk is full." }))
        .status,
    ).toBe(204);
    [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "failed",
      syncError: "Disk is full.",
    });

    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [baseline.profileId],
        })
      ).status,
    ).toBe(200);
    [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      profileId: baseline.profileId,
      syncStatus: "pending",
      warnings: [],
    });
    expect(
      (await assign(owner, device.instanceId, { profileId: null })).status,
    ).toBe(200);
    expect((await listAssignments(owner))[0]?.syncStatus).toBe("unassigned");
    const missing = await assign(owner, "instance_missing", {
      profileIds: [baseline.profileId],
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("Instance was not found.");
  });

  it("resets the remaining layers when a stacked profile is deleted", async () => {
    const device = await enroll();
    const owner = await login();
    const first = await createProfile(owner, "First", () => {});
    const middle = await createProfile(owner, "Middle", () => {});
    const last = await createProfile(owner, "Last", () => {});
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [first.profileId, middle.profileId, last.profileId],
        })
      ).status,
    ).toBe(200);
    const applyDelivery = async () => {
      const delivery = (await (
        await fetchDelivery(device, 3)
      ).json()) as FleetManagedSettingsDelivery;
      const layers = delivery.layers!.map(({ profileId, revision }) => ({
        profileId,
        revision,
      }));
      const report = await deviceRequest(device, "sync-status", "PUT", {
        managerId: delivery.managerId,
        status: "applied",
        profileId: layers[0]!.profileId,
        revision: layers[0]!.revision,
        layers,
        warnings: ["Your local Review prompt is hidden while managed."],
      });
      expect(report.status).toBe(204);
      return delivery;
    };
    await applyDelivery();
    expect((await listAssignments(owner))[0]?.syncStatus).toBe("applied");

    expect(
      (
        await apiRequest(
          `/api/settings/profiles/${middle.profileId}`,
          "DELETE",
          undefined,
          owner,
        )
      ).status,
    ).toBe(200);
    const [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "pending",
      warnings: [],
      layers: [
        {
          profileId: first.profileId,
          position: 0,
          syncStatus: "pending",
          lastAppliedRevision: null,
        },
        { profileId: last.profileId, position: 1, syncStatus: "pending" },
      ],
    });
    expect(assignment.layers).toHaveLength(2);
    const remaining = await applyDelivery();
    expect(remaining.layers?.map((layer) => layer.name)).toEqual([
      "First",
      "Last",
    ]);
    expect((await listAssignments(owner))[0]?.syncStatus).toBe("applied");
  });

  it("rejects stacks whose combined collections exceed the limits", async () => {
    const device = await enroll();
    const owner = await login();
    runtime.config.settingsManager.limits.maximumInstructionsPerProfile = 1;
    const first = await createProfile(owner, "First", (document) => {
      document.instructions = [instruction(uuid(4), "One", "1")];
    });
    const second = await createProfile(owner, "Second", (document) => {
      document.instructions = [instruction(uuid(5), "Two", "2")];
    });
    const response = await assign(owner, device.instanceId, {
      profileIds: [first.profileId, second.profileId],
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("combined settings limits");
  });

  it("rejects profile changes that push a stacked device over the combined limits", async () => {
    const device = await enroll();
    const owner = await login();
    runtime.config.settingsManager.limits.maximumInstructionsPerProfile = 1;
    const first = await createProfile(owner, "First", (document) => {
      document.instructions = [instruction(uuid(10), "One", "1")];
    });
    const second = await createProfile(owner, "Second", (document) => {
      document.instructions = [instruction(uuid(11), "Two", "2")];
    });
    expect(
      (
        await updateProfile(owner, second.profileId, (document) => {
          document.instructions = [];
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [first.profileId, second.profileId],
        })
      ).status,
    ).toBe(200);

    const grown = await updateProfile(owner, second.profileId, (document) => {
      document.instructions = [instruction(uuid(11), "Two", "2")];
    });
    expect(grown.status).toBe(409);
    expect((await grown.json()).error).toContain(
      "on a device that also uses other profiles",
    );
    const restored = await apiRequest(
      `/api/settings/profiles/${second.profileId}/versions/${second.revision}/restore`,
      "POST",
      { expectedRevision: second.revision + 1 },
      owner,
    );
    expect(restored.status).toBe(409);

    // A stack that is already too large (for example after the limits were
    // lowered) stays editable, and the device is told it cannot be delivered.
    const current = await runtime.settingsStore.getProfile(second.profileId);
    await runtime.settingsStore.updateProfile(
      second.profileId,
      current.revision,
      current.name,
      current.description,
      {
        ...current.document,
        instructions: [instruction(uuid(11), "Two", "2")],
      },
      "Changed outside the editor",
      nowSeconds(),
      100,
    );
    const blocked = await fetchDelivery(device, 3);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain("combined settings limits");
    expect((await listAssignments(owner))[0]).toMatchObject({
      syncStatus: "failed",
      syncError: "The assigned profiles exceed the combined settings limits.",
      layers: [{ syncStatus: "failed" }, { syncStatus: "failed" }],
    });
    // Polling again neither rewrites the rows nor adds audit entries.
    await runtime.database.run(
      "UPDATE settings_profile_assignments SET last_sync_attempt_at = 1 WHERE instance_id = $1",
      device.instanceId,
    );
    const audits = await auditCount();
    expect((await fetchDelivery(device, 3)).status).toBe(409);
    expect(await auditCount()).toBe(audits);
    expect(
      (await listAssignments(owner))[0]?.layers.map(
        (layer: { lastSyncAttemptAt: number }) => layer.lastSyncAttemptAt,
      ),
    ).toEqual([1, 1]);
    expect(
      (
        await updateProfile(owner, second.profileId, (document) => {
          document.instructions[0]!.body = "Still two";
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await updateProfile(owner, first.profileId, (document) => {
          document.instructions = [];
        })
      ).status,
    ).toBe(200);
    expect((await fetchDelivery(device, 3)).status).toBe(200);
    expect((await listAssignments(owner))[0]?.syncStatus).toBe("pending");
  });

  it("rejects names that devices would treat as the same item", async () => {
    const owner = await login();
    const profile = await createProfile(owner, "Names", () => {});
    const response = await updateProfile(
      owner,
      profile.profileId,
      (document) => {
        document.instructions = [
          instruction(uuid(12), "\uFB01le", "Ligature"),
          instruction(uuid(13), "File", "Plain"),
        ];
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Instruction ids and names must be unique.",
    );
  });

  it("limits secrets per profile and per stack to what devices accept", async () => {
    const device = await enroll();
    const laptop = await enroll("Laptop");
    const owner = await login();
    const crowded = await createProfile(owner, "Crowded", () => {});
    const large = await createProfile(owner, "Large", () => {});
    const small = await createProfile(owner, "Small", () => {});
    const addSecrets = (profileId: string, prefix: string, count: number) =>
      runtime.database.run(
        "INSERT INTO settings_secrets (profile_id, secret_id, ciphertext, last_four, updated_at)\n         SELECT $1, $2::text || n, decode('00', 'hex'), 'abcd', 1 FROM generate_series(1, $3::integer) AS n",
        profileId,
        prefix,
        count,
      );
    const secret = async (profileId: string, secretId: string) => {
      const { profile } = await (
        await apiRequest(
          `/api/settings/profiles/${profileId}`,
          "GET",
          undefined,
          owner,
        )
      ).json();
      return apiRequest(
        `/api/settings/profiles/${profileId}/secrets/${secretId}`,
        "PUT",
        { expectedRevision: profile.revision, value: "token" },
        owner,
      );
    };
    await addSecrets(crowded.profileId, "mcp_crowded_", 128);
    const rejected = await secret(crowded.profileId, "mcp_extra");
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error).toBe(
      "A settings profile can store at most 128 secrets.",
    );
    expect((await secret(crowded.profileId, "mcp_crowded_1")).status).toBe(200);

    // A stack holds at most 128 distinct secrets, also when one is added later.
    await addSecrets(large.profileId, "mcp_large_", 127);
    await addSecrets(small.profileId, "mcp_small_", 1);
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [large.profileId, small.profileId],
        })
      ).status,
    ).toBe(200);
    const added = await secret(small.profileId, "mcp_extra");
    expect(added.status).toBe(409);
    expect((await added.json()).error).toContain("combined settings limits");
    expect((await secret(small.profileId, "mcp_small_1")).status).toBe(200);
    expect((await secret(small.profileId, "mcp_large_2")).status).toBe(200);

    const stacked = await assign(owner, laptop.instanceId, {
      profileIds: [crowded.profileId, small.profileId],
    });
    expect(stacked.status).toBe(409);
    expect((await stacked.json()).error).toContain("combined settings limits");
  });

  it("drops the enforcement of a removed secret", async () => {
    const owner = await login();
    const profile = await createProfile(owner, "Keys", (document) => {
      document.policy = { enforced: ["model", "secret:openai"] };
    });
    await setSecret(owner, profile.profileId, "openai", "sk-first");
    const { profile: current } = await (
      await apiRequest(
        `/api/settings/profiles/${profile.profileId}`,
        "GET",
        undefined,
        owner,
      )
    ).json();
    const removed = await apiRequest(
      `/api/settings/profiles/${profile.profileId}/secrets/openai`,
      "DELETE",
      { expectedRevision: current.revision },
      owner,
    );
    expect(removed.status).toBe(200);
    const updated = (await removed.json()).profile;
    expect(updated.document.policy).toEqual({ enforced: ["model"] });
    expect(
      await runtime.settingsStore.getVersionDocument(
        profile.profileId,
        updated.revision,
      ),
    ).toMatchObject({ policy: { enforced: ["model"] } });
    await setSecret(owner, profile.profileId, "openai", "sk-second");
    expect(
      (await runtime.settingsStore.getProfile(profile.profileId)).document
        .policy,
    ).toEqual({ enforced: ["model"] });
  });

  it("follows the first layer for devices that run an older Machdoch version", async () => {
    const device = await enroll();
    const owner = await login();
    const team = await createProfile(owner, "Team", () => {});
    const baseline = await createProfile(owner, "Baseline", () => {});
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [team.profileId, baseline.profileId],
        })
      ).status,
    ).toBe(200);
    const legacy = (await (
      await fetchDelivery(device)
    ).json()) as FleetManagedSettingsDelivery;
    expect(legacy.profile?.profileId).toBe(team.profileId);
    const report = (body: Record<string, unknown>) =>
      deviceRequest(device, "sync-status", "PUT", {
        managerId: legacy.managerId,
        ...body,
      });
    const notice =
      "This device runs an older Machdoch version and only applies the first profile (Team). Update Machdoch to apply all profiles.";
    expect(
      (
        await report({
          status: "applied",
          profileId: baseline.profileId,
          revision: baseline.revision,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await report({
          status: "applied",
          profileId: team.profileId,
          revision: team.revision,
        })
      ).status,
    ).toBe(204);
    let [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "applied",
      warnings: [notice],
      layers: [
        { syncStatus: "applied" },
        { syncStatus: "pending", lastSyncAttemptAt: null },
      ],
    });

    // An updated client reports every layer and replaces the notice.
    const layers = (
      (await (
        await fetchDelivery(device, 3)
      ).json()) as FleetManagedSettingsDelivery
    ).layers!.map(({ profileId, revision }) => ({ profileId, revision }));
    expect(
      (
        await report({
          status: "applied",
          profileId: team.profileId,
          revision: team.revision,
          layers,
        })
      ).status,
    ).toBe(204);
    [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "applied",
      warnings: [],
      layers: [{ syncStatus: "applied" }, { syncStatus: "applied" }],
    });

    // A report from an old client again clears what the lower layer showed.
    expect(
      (
        await report({
          status: "failed",
          profileId: team.profileId,
          revision: team.revision,
          error: "Disk is full.",
        })
      ).status,
    ).toBe(204);
    [assignment] = await listAssignments(owner);
    expect(assignment).toMatchObject({
      syncStatus: "failed",
      syncError: "Disk is full.",
      warnings: [notice],
      layers: [
        { syncStatus: "failed" },
        { syncStatus: "pending", lastAppliedRevision: null },
      ],
    });
  });

  it("lets an assignment written by an older cloud replace the stack on restart", async () => {
    const device = await enroll();
    const owner = await login();
    const team = await createProfile(owner, "Team", () => {});
    const baseline = await createProfile(owner, "Baseline", () => {});
    const legacy = await createProfile(owner, "Legacy", () => {});
    expect(
      (
        await assign(owner, device.instanceId, {
          profileIds: [team.profileId, baseline.profileId],
        })
      ).status,
    ).toBe(200);
    await runtime.database.run(
      "INSERT INTO settings_assignments (instance_id, profile_id, assigned_at) VALUES ($1, $2, 1)",
      device.instanceId,
      legacy.profileId,
    );
    await runtime.database.initialize();
    await runtime.database.initialize();
    const layer = { profileId: legacy.profileId, revision: legacy.revision };
    expect(
      await runtime.settingsStore.getDeliveryIdentity(device.instanceId),
    ).toEqual({ ...layer, layers: [layer] });
    expect(
      await runtime.database.all(
        "SELECT instance_id FROM settings_assignments",
      ),
    ).toEqual([]);
  });

  it("re-uploads snapshots on request and creates profiles from them", async () => {
    const device = await enroll();
    const owner = await login();
    const status = async () =>
      (await deviceRequest(device, "snapshot", "GET")).json();
    expect(await status()).toEqual({ requested: true, capturedAt: null });
    const snapshot = emptySettingsDocument();
    snapshot.defaults.theme = "dark";
    snapshot.instructions = [instruction(uuid(6), "Review", "Look closely")];
    expect(
      (await deviceRequest(device, "snapshot", "PUT", snapshot)).status,
    ).toBe(204);
    expect(await status()).toMatchObject({
      requested: false,
      capturedAt: expect.any(Number),
    });
    snapshot.defaults.theme = "light";
    expect(
      (await deviceRequest(device, "snapshot", "PUT", snapshot)).status,
    ).toBe(204);
    expect(
      (
        await (
          await apiRequest(
            `/api/settings/instances/${device.instanceId}/enrollment`,
            "GET",
            undefined,
            owner,
          )
        ).json()
      ).document.defaults.theme,
    ).toBe("light");

    expect(
      (await (await deviceRequest(device, "enrollment", "GET")).json())
        .captureRequired,
    ).toBe(false);
    expect(
      (
        await apiRequest(
          `/api/settings/instances/${device.instanceId}/snapshot/refresh`,
          "POST",
          {},
          owner,
        )
      ).status,
    ).toBe(200);
    expect((await status()).requested).toBe(true);
    expect(
      (await (await deviceRequest(device, "enrollment", "GET")).json())
        .captureRequired,
    ).toBe(true);
    snapshot.defaults.theme = "dark";
    expect(
      (await deviceRequest(device, "enrollment", "PUT", snapshot)).status,
    ).toBe(204);
    expect((await status()).requested).toBe(false);
    expect((await listAssignments(owner))[0]?.snapshot).toMatchObject({
      capturedAt: expect.any(Number),
      refreshRequestedAt: null,
    });

    const created = await apiRequest(
      "/api/settings/profiles",
      "POST",
      { name: "From device", sourceInstanceId: device.instanceId },
      owner,
    );
    expect(created.status).toBe(200);
    const { profile } = await created.json();
    expect(profile.document).toMatchObject({
      defaults: { theme: "dark" },
      instructions: [{ name: "Review", body: "Look closely" }],
      policy: { enforced: [] },
      mcpServers: [],
    });
    const other = await enroll("Laptop");
    expect(
      (
        await apiRequest(
          "/api/settings/profiles",
          "POST",
          { name: "Missing", sourceInstanceId: other.instanceId },
          owner,
        )
      ).status,
    ).toBe(404);
  });

  it("queues device proposals for owner review", async () => {
    const device = await enroll("Workstation");
    const owner = await login();
    const profile = await createProfile(owner, "Engineering", (document) => {
      document.instructions = [instruction(uuid(7), "Review", "Old")];
    });
    const propose = (body: unknown) =>
      deviceRequest(device, "proposals", "POST", body);
    expect(
      (await propose({ kind: "instruction", item: { name: "No id" } })).status,
    ).toBe(400);
    const first = await propose({
      kind: "instruction",
      item: instruction(uuid(8), "Review", "New"),
      note: "We use this everywhere.",
    });
    expect(first.status).toBe(201);
    const second = await propose({
      kind: "prompt",
      item: {
        id: uuid(9),
        relativePath: "release.prompt.md",
        content: "Prepare the release.",
      },
    });
    expect(second.status).toBe(201);
    const { proposals } = await (
      await apiRequest("/api/settings/proposals", "GET", undefined, owner)
    ).json();
    expect(proposals).toHaveLength(2);
    const review = proposals.find(
      (proposal: { kind: string }) => proposal.kind === "instruction",
    );
    expect(review).toMatchObject({
      displayName: "Workstation",
      note: "We use this everywhere.",
      item: { name: "Review", body: "New" },
    });
    const accept = (proposalId: string, resolution: string, revision: number) =>
      apiRequest(
        `/api/settings/proposals/${proposalId}/accept`,
        "POST",
        {
          profileId: profile.profileId,
          expectedRevision: revision,
          resolution,
        },
        owner,
      );
    const added = await accept(review.proposalId, "add", profile.revision);
    expect(added.status).toBe(409);
    expect((await added.json()).error).toContain("already exists");
    const kept = await accept(review.proposalId, "keep-both", profile.revision);
    expect(kept.status).toBe(200);
    const keptProfile = (await kept.json()).profile;
    expect(
      keptProfile.document.instructions.map(
        (item: { name: string; body: string }) => `${item.name}:${item.body}`,
      ),
    ).toEqual(["Review:Old", "Review (2):New"]);
    expect(keptProfile.revision).toBe(profile.revision + 1);
    expect(
      (await accept(review.proposalId, "replace", keptProfile.revision)).status,
    ).toBe(404);
    const releaseId = proposals.find(
      (proposal: { kind: string }) => proposal.kind === "prompt",
    ).proposalId;
    expect(
      (
        await apiRequest(
          `/api/settings/proposals/${releaseId}/reject`,
          "POST",
          {},
          owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await apiRequest("/api/settings/proposals", "GET", undefined, owner)
        ).json()
      ).proposals,
    ).toEqual([]);

    const server = await propose({
      kind: "mcpServer",
      item: {
        id: "docs",
        title: "Docs",
        enabled: true,
        transport: {
          type: "streamable-http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: "Bearer {{secret:mcp_docs_token}}" },
        },
      },
    });
    expect(server.status).toBe(201);
    const { proposalId } = await server.json();
    expect((await accept(proposalId, "add", keptProfile.revision)).status).toBe(
      200,
    );
    const { versions } = await (
      await apiRequest(
        `/api/settings/profiles/${profile.profileId}/versions`,
        "GET",
        undefined,
        owner,
      )
    ).json();
    expect(
      versions
        .slice(0, 2)
        .map((version: { changeSummary: string }) => version.changeSummary),
    ).toEqual([
      "Accepted MCP server from Workstation",
      "Accepted instruction from Workstation",
    ]);

    // Notes are limited by characters, as on the device, not UTF-16 units.
    const prompt = (note: string) =>
      propose({
        kind: "prompt",
        item: {
          id: uuid(14),
          relativePath: "notes.prompt.md",
          content: "Summarize.",
        },
        note,
      });
    expect((await prompt("\u{1F600}".repeat(500))).status).toBe(201);
    expect((await prompt("\u{1F600}".repeat(501))).status).toBe(400);
  });
});

interface Owner {
  cookie: string;
  csrf: string;
}

async function login(): Promise<Owner> {
  const response = await apiRequest("/api/v1/auth/login", "POST", {
    email: "owner",
    password: "a secure test password",
  });
  const cookies = response.headers.getSetCookie();
  const csrf = /^__Host-machdoch_cloud_csrf=([^;]+)/mu.exec(
    cookies.join("\n"),
  )?.[1];
  if (!csrf) throw new Error("Missing test CSRF cookie.");
  return {
    cookie: cookies.map((value) => value.split(";", 1)[0]).join("; "),
    csrf,
  };
}

async function enroll(displayName = "Test") {
  const enrollmentKey = createSecret("mch_enroll");
  const instanceSecret = createSecret("mch_instance");
  await runtime.fleetStore.createEnrollmentGrant(
    enrollmentKey,
    nowSeconds(),
    runtime.config.enrollmentPolicy,
  );
  const instance = await runtime.fleetStore.enrollInstance(
    {
      enrollmentKey,
      instanceSecret,
      displayName,
      productVersion: "37.2.0",
      protocolVersion: gatewayProtocolVersion,
    },
    nowSeconds(),
  );
  return { ...instance, instanceSecret };
}

type DocumentChange = (
  document: ReturnType<typeof emptySettingsDocument>,
) => void;

async function createProfile(
  owner: Owner,
  name: string,
  change: DocumentChange,
) {
  const created = await (
    await apiRequest("/api/settings/profiles", "POST", { name }, owner)
  ).json();
  const response = await updateProfile(
    owner,
    created.profile.profileId,
    change,
  );
  expect(response.status).toBe(200);
  return (await response.json()).profile as {
    profileId: string;
    revision: number;
  };
}

async function updateProfile(
  owner: Owner,
  profileId: string,
  change: DocumentChange,
) {
  const { profile } = await (
    await apiRequest(
      `/api/settings/profiles/${profileId}`,
      "GET",
      undefined,
      owner,
    )
  ).json();
  change(profile.document);
  return apiRequest(
    `/api/settings/profiles/${profileId}`,
    "PUT",
    {
      expectedRevision: profile.revision,
      name: profile.name,
      document: profile.document,
    },
    owner,
  );
}

async function setSecret(
  owner: Owner,
  profileId: string,
  secretId: string,
  value: string,
) {
  const current = await (
    await apiRequest(
      `/api/settings/profiles/${profileId}`,
      "GET",
      undefined,
      owner,
    )
  ).json();
  const response = await apiRequest(
    `/api/settings/profiles/${profileId}/secrets/${secretId}`,
    "PUT",
    { expectedRevision: current.profile.revision, value },
    owner,
  );
  expect(response.status).toBe(200);
}

async function auditCount() {
  return (
    await runtime.database.get(
      "SELECT COUNT(*)::integer AS count FROM audit_log",
    )
  )?.count;
}

function assign(owner: Owner, instanceId: string, body: unknown) {
  return apiRequest(
    `/api/settings/instances/${instanceId}/assignment`,
    "PUT",
    body,
    owner,
  );
}

async function listAssignments(owner: Owner) {
  return (
    await (
      await apiRequest("/api/settings/assignments", "GET", undefined, owner)
    ).json()
  ).assignments;
}

function fetchDelivery(
  device: { instanceId: string; instanceSecret: string },
  schemaVersion?: number,
  etag?: string,
) {
  const headers = new Headers({
    Authorization: `Bearer ${device.instanceSecret}`,
  });
  if (etag) headers.set("If-None-Match", etag);
  return handleApiRequest(
    new Request(
      `${origin}/api/client/settings/${device.instanceId}${schemaVersion ? `?schemaVersion=${schemaVersion}` : ""}`,
      { headers },
    ),
    { clientAddress: "198.51.100.10" },
  );
}

function deviceRequest(
  device: { instanceId: string; instanceSecret: string },
  route: string,
  method: string,
  body?: unknown,
) {
  const headers = new Headers({
    Authorization: `Bearer ${device.instanceSecret}`,
  });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return handleApiRequest(
    new Request(`${origin}/api/client/settings/${device.instanceId}/${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { clientAddress: "198.51.100.10" },
  );
}

function apiRequest(
  path: string,
  method: string,
  body?: unknown,
  owner?: Owner,
) {
  const headers = new Headers({ Origin: origin });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (owner) {
    headers.set("Cookie", owner.cookie);
    headers.set("X-Machdoch-Cloud-CSRF", owner.csrf);
  }
  return handleApiRequest(
    new Request(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { clientAddress: "198.51.100.10" },
  );
}
