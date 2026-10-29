import assert from "node:assert/strict";
import test from "node:test";
import {
  createFleetManagedSettingsEtag,
  fleetManagedSettingsDeliverySchema,
  managedSettingsDocumentSchema,
  type FleetManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import {
  composeManagedSettingsLayers,
  emptyManagedSettingsDocument,
  explicitManagedSettingsPolicy,
  isManagedSettingEnforced,
  managedMcpServerSecretReferences,
  normalizeManagedItemName,
  substituteManagedSecrets,
  toLegacyManagedSettingsDocument,
} from "@machdoch/fleet-protocol/managed-settings";

const managerId = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";
const baselineId = "profile_MDEyMzQ1Njc4OTAxMjM0NTY3";
const teamId = "profile_MDEyMzQ1Njc4OTAxMjM0NTY4";

const document = (
  patch: Partial<FleetManagedSettingsDocument> = {},
): FleetManagedSettingsDocument => ({
  ...emptyManagedSettingsDocument(),
  ...patch,
});

const instruction = (id: string, name: string, body: string) => ({
  id,
  name,
  body,
  enabled: true,
  global: true,
  tags: [],
});

void test("legacy documents enforce every configured value", () => {
  const legacy = toLegacyManagedSettingsDocument(document());
  assert.equal(isManagedSettingEnforced(legacy, "model"), true);
  assert.equal(
    isManagedSettingEnforced(document({ policy: { enforced: [] } }), "model"),
    false,
  );
  const configured = toLegacyManagedSettingsDocument(document());
  configured.defaults.provider = "openai";
  configured.defaults.model = "gpt-5.6";
  configured.agentLimits.executorTurns = 12;
  assert.deepEqual(explicitManagedSettingsPolicy(configured, ["openai"]), [
    "model",
    "executorTurns",
    "secret:openai",
  ]);
});

void test("enforced values beat defaults from higher-priority layers", () => {
  const team = document({ policy: { enforced: [] } });
  team.defaults.provider = "anthropic";
  team.defaults.model = "claude-opus-5-5";
  team.defaults.theme = "light";
  const baseline = document({ policy: { enforced: ["model", "secret:openai"] } });
  baseline.defaults.provider = "openai";
  baseline.defaults.model = "gpt-5.6";
  baseline.defaults.theme = "dark";
  baseline.defaults.mode = "ask";

  const composed = composeManagedSettingsLayers([
    { document: team, secrets: { openai: "team-key", tavily: "team-search" } },
    { document: baseline, secrets: { openai: "company-key" } },
  ]);

  assert.equal(composed.document.defaults.provider, "openai");
  assert.equal(composed.document.defaults.model, "gpt-5.6");
  assert.equal(composed.document.defaults.theme, "light");
  assert.equal(composed.document.defaults.mode, "ask");
  assert.deepEqual(composed.secrets, {
    openai: "company-key",
    tavily: "team-search",
  });
  assert.deepEqual(composed.document.policy?.enforced, [
    "model",
    "secret:openai",
  ]);
});

void test("collections merge by name with the first layer winning", () => {
  const team = document({
    instructions: [
      instruction("123e4567-e89b-42d3-a456-426614174000", "Code style", "Team"),
    ],
  });
  const baseline = document({
    instructions: [
      instruction("123e4567-e89b-42d3-a456-426614174001", "code style", "Base"),
      instruction("123e4567-e89b-42d3-a456-426614174002", "Security", "Safe"),
    ],
  });
  const composed = composeManagedSettingsLayers([
    { document: team, secrets: {} },
    { document: baseline, secrets: {} },
  ]);
  assert.deepEqual(
    composed.document.instructions.map((item) => item.body),
    ["Team", "Safe"],
  );
  assert.equal(managedSettingsDocumentSchema.safeParse(composed.document).success, true);
});

void test("item names fold case like the device instruction library", () => {
  assert.equal(
    normalizeManagedItemName(" Straße "),
    normalizeManagedItemName("STRASSE"),
  );
  assert.equal(normalizeManagedItemName("ﬁle"), normalizeManagedItemName("FILE"));
  assert.notEqual(normalizeManagedItemName("Review"), normalizeManagedItemName("Reviews"));
});

void test("MCP servers validate and expose secret placeholders", () => {
  const server = {
    id: "github",
    title: "GitHub",
    enabled: true,
    transport: {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "{{secret:mcp_github}}" },
    },
  };
  assert.equal(
    managedSettingsDocumentSchema.safeParse(document({ mcpServers: [server] }))
      .success,
    true,
  );
  assert.deepEqual(managedMcpServerSecretReferences(server), ["mcp_github"]);
  assert.deepEqual(
    substituteManagedSecrets(
      "Bearer {{secret:mcp_github}} {{secret:mcp_x}} {{secret:mcp_x}}",
      { mcp_github: "token" },
    ),
    {
      value: "Bearer token {{secret:mcp_x}} {{secret:mcp_x}}",
      missing: ["mcp_x"],
    },
  );
  // Repeated calls must not depend on regular expression state.
  assert.deepEqual(managedMcpServerSecretReferences(server), ["mcp_github"]);
  assert.equal(
    managedSettingsDocumentSchema.safeParse(
      document({ mcpServers: [server, { ...server, title: null }] }),
    ).success,
    false,
  );
  assert.equal(
    managedSettingsDocumentSchema.safeParse(
      document({
        mcpServers: [
          {
            ...server,
            transport: { type: "sse", url: "file:///etc/passwd", headers: {} },
          },
        ],
      }),
    ).success,
    false,
  );
});

void test("deliveries accept both schema versions with matching layers", () => {
  const profile = {
    profileId: baselineId,
    name: "Baseline + Team",
    revision: 3,
    document: document(),
    secrets: {},
  };
  const current = {
    schemaVersion: 3,
    managerId,
    profile,
    layers: [
      { profileId: baselineId, name: "Baseline", revision: 3 },
      { profileId: teamId, name: "Team", revision: 7 },
    ],
  };
  assert.equal(fleetManagedSettingsDeliverySchema.safeParse(current).success, true);
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse({
      ...current,
      layers: [{ profileId: teamId, name: "Team", revision: 7 }],
    }).success,
    false,
  );
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse({ ...current, schemaVersion: 2 })
      .success,
    false,
  );
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse({
      schemaVersion: 2,
      managerId,
      profile: {
        ...profile,
        document: toLegacyManagedSettingsDocument(profile.document),
      },
    }).success,
    true,
  );
  assert.equal(
    createFleetManagedSettingsEtag(current),
    `"managed-settings.v3.${managerId}.${baselineId}.3+${teamId}.7"`,
  );
  assert.equal(
    createFleetManagedSettingsEtag({ managerId, profile: null }),
    `"managed-settings.${managerId}.unassigned"`,
  );
});
