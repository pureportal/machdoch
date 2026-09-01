import type { FleetManagedSettingsDocument } from "@machdoch/fleet-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  type FleetManagedSettingsState,
  type SmartContextPack,
} from "../../chat-session.model";
import {
  applyManagedShellSettings,
  createManagedContextPacks,
  synchronizeSecrets,
} from "./use-fleet-managed-settings";

const secretRuntime = vi.hoisted(() => ({
  deleteUserProviderApiKey: vi.fn(),
  deleteUserWebSearchApiKey: vi.fn(),
  loadUserProviderApiKeys: vi.fn(),
  loadUserWebSearchSettings: vi.fn(),
  saveUserProviderApiKey: vi.fn(),
  saveUserWebSearchApiKey: vi.fn(),
}));

vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  ...secretRuntime,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const localPack = (id: string, name: string): SmartContextPack => ({
  id,
  workspace: null,
  name,
  instructions: "Local instructions",
  prompt: "",
  contextAttachments: [],
  variables: [],
  trigger: { phrases: [], pathPatterns: [] },
  createdAt: 10,
  updatedAt: 20,
  lastUsedAt: 30,
  useCount: 4,
});

const document = (): FleetManagedSettingsDocument => ({
  defaults: {
    provider: "openai",
    model: "gpt-5.6",
    mode: "ask",
    reasoning: "high",
    webSearchProvider: null,
    theme: null,
    density: null,
    accent: null,
  },
  agentLimits: {
    infinite: null,
    executorTurns: null,
    autopilotExecutorIterations: null,
  },
  instructions: [],
  contextPacks: [
    {
      id: "managed-pack",
      name: "Managed pack",
      instructions: "Managed instructions",
      prompt: "Managed prompt",
      provider: "openai",
      model: "gpt-5.6",
      mode: "machdoch",
      reasoning: "medium",
      variables: [{ name: "target", defaultValue: "production" }],
      triggerPhrases: ["ship it"],
      pathPatterns: ["src/**"],
      promptEnhancementMode: "web-search",
      interviewEnabled: true,
      sessionMemoryEnabled: false,
      useGlobalMemory: true,
      uiControlEnabled: false,
    },
  ],
  prompts: [],
});

const metadata: FleetManagedSettingsState = {
  managerId: "manager-one",
  profileId: "profile-one",
  revision: 2,
  instructionProfileIds: {},
  contextPackIds: ["fleet:manager-one:managed-pack"],
  secretIds: [],
  appliedAt: 100,
};

describe("Fleet managed settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretRuntime.loadUserProviderApiKeys.mockResolvedValue({});
    secretRuntime.loadUserWebSearchSettings.mockResolvedValue({
      activeProvider: "none",
      apiKeys: {},
      providerAvailability: [],
    });
  });

  it("replaces managed packs without removing local packs", () => {
    const state = createInitialShellState();
    state.contextPacks = [
      localPack("local-pack", "Local pack"),
      localPack("old-managed-pack", "Old managed pack"),
    ];
    state.fleetManagedSettings = {
      ...metadata,
      revision: 1,
      contextPackIds: ["old-managed-pack"],
    };

    const managedPacks = createManagedContextPacks(
      document(),
      state.contextPacks,
      "manager-one",
    );
    const next = applyManagedShellSettings(
      state,
      document(),
      managedPacks,
      metadata,
    );

    expect(next.contextPacks.map((pack) => pack.id)).toEqual([
      "fleet:manager-one:managed-pack",
      "local-pack",
    ]);
    expect(next.contextPacks[0]).toMatchObject({
      name: "Managed pack",
      provider: "openai",
      model: "gpt-5.6",
      mode: "machdoch",
      reasoning: "medium",
      variables: [{ name: "target", defaultValue: "production" }],
      trigger: { phrases: ["ship it"], pathPatterns: ["src/**"] },
      promptEnhancementMode: "web-search",
      interviewEnabled: true,
      sessionMemoryEnabled: false,
      useGlobalMemory: true,
      uiControlEnabled: false,
    });
    expect(next.fleetManagedSettings).toEqual(metadata);
    expect(next.lastSelectedProvider).toBe("openai");
    expect(next.lastSelectedModelByProvider.openai).toBe("gpt-5.6");
    expect(next.lastSelectedMode).toBe("ask");
    expect(next.lastSelectedReasoning).toBe("high");
  });

  it("preserves usage metadata when a managed pack is revised", () => {
    const current = localPack(
      "fleet:manager-one:managed-pack",
      "Previous managed pack",
    );
    const [managed] = createManagedContextPacks(
      document(),
      [current],
      "manager-one",
      [current.id],
    );

    expect(managed).toMatchObject({
      id: "fleet:manager-one:managed-pack",
      createdAt: 10,
      lastUsedAt: 30,
      useCount: 4,
    });
  });

  it("rejects a managed pack collision with local data", () => {
    const current = localPack("fleet:manager-one:managed-pack", "Local pack");

    expect(() =>
      createManagedContextPacks(document(), [current], "manager-one"),
    ).toThrow(/conflicts with a local pack/u);
  });

  it("reuses an unchanged managed pack", () => {
    const [first] = createManagedContextPacks(document(), [], "manager-one");
    if (!first) throw new Error("Managed pack was not created.");
    const [second] = createManagedContextPacks(
      document(),
      [first],
      "manager-one",
      [first.id],
    );

    expect(second).toBe(first);
  });

  it("removes managed credentials that are no longer assigned", async () => {
    const secretIds = await synchronizeSecrets(
      { openai: "openai-key", tavily: "tavily-key", custom: "ignored" },
      ["anthropic", "tavily", "custom"],
    );

    expect(secretIds).toEqual(["openai", "tavily"]);
    expect(secretRuntime.saveUserProviderApiKey).toHaveBeenCalledWith(
      "openai",
      "openai-key",
    );
    expect(secretRuntime.saveUserWebSearchApiKey).toHaveBeenCalledWith(
      "tavily",
      "tavily-key",
    );
    expect(secretRuntime.deleteUserProviderApiKey).toHaveBeenCalledWith(
      "anthropic",
    );
    expect(secretRuntime.deleteUserWebSearchApiKey).not.toHaveBeenCalled();
  });

  it("does not rewrite credentials that already match", async () => {
    secretRuntime.loadUserProviderApiKeys.mockResolvedValue({
      openai: "openai-key",
    });
    secretRuntime.loadUserWebSearchSettings.mockResolvedValue({
      activeProvider: "tavily",
      apiKeys: { tavily: "tavily-key" },
      providerAvailability: [],
    });

    await synchronizeSecrets({ openai: "openai-key", tavily: "tavily-key" }, [
      "openai",
      "tavily",
    ]);

    expect(secretRuntime.saveUserProviderApiKey).not.toHaveBeenCalled();
    expect(secretRuntime.saveUserWebSearchApiKey).not.toHaveBeenCalled();
  });
});
