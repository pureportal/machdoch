import type { FleetManagedSettingsDocument } from "@machdoch/fleet-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  type FleetManagedSettingsState,
  type ShellPersistedState,
} from "../../chat-session.model";
import { type SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import type { InstructionProfileView } from "../../runtime";
import {
  applyManagedSettings,
  applyManagedShellSettings,
  createEnrollmentSettingsDocument,
  createSyncQueue,
  planManagedContextPacks,
  planManagedFields,
  synchronizeInstructions,
  type FieldSnapshot,
  type ManagedEnvironment,
} from "./use-fleet-managed-settings";

const library = vi.hoisted(() => ({
  profiles: [] as InstructionProfileView[],
  revision: 1,
  failNames: new Set<string>(),
}));

const instructionRuntime = vi.hoisted(() => ({
  listInstructions: vi.fn(async () => ({
    revision: library.revision,
    profiles: library.profiles.map((profile) => ({ ...profile })),
  })),
  mutateInstructions: vi.fn(
    async (
      _workspace: string | null,
      input: {
        operation: string;
        profileId: string;
        name?: string;
        body?: string;
        enabled?: boolean;
        global?: boolean;
        tags?: string[];
      },
    ) => {
      if (input.name && library.failNames.has(input.name))
        throw new Error("The instruction library is unavailable.");
      // Like the real library, names are unique ignoring case.
      if (
        input.name &&
        library.profiles.some(
          (profile) =>
            profile.id !== input.profileId &&
            profile.name.toLowerCase() === input.name!.toLowerCase(),
        )
      )
        throw new Error(`Duplicate normalized profile name "${input.name}".`);
      library.revision += 1;
      if (input.operation === "profile-delete") {
        library.profiles = library.profiles.filter(
          (profile) => profile.id !== input.profileId,
        );
        return { library: { revision: library.revision } };
      }
      const profile = {
        id: input.profileId,
        name: input.name!,
        body: input.body!,
        enabled: input.enabled!,
        global: input.global!,
        tags: input.tags!,
      } as InstructionProfileView;
      library.profiles = [
        ...library.profiles.filter((entry) => entry.id !== input.profileId),
        profile,
      ];
      return { library: { revision: library.revision }, profile };
    },
  ),
}));

const deviceRuntime = vi.hoisted(() => ({
  synchronizeFleetManagedPrompts: vi.fn(async () => {}),
  releaseFleetManagedApiKeys: vi.fn(async () => []),
  deleteUserProviderApiKey: vi.fn(async () => {}),
  deleteUserWebSearchApiKey: vi.fn(async () => {}),
  loadUserWebSearchSettings: vi.fn(async () => ({
    activeProvider: "none",
    apiKeys: {},
  })),
  saveUserWebSearchActiveProvider: vi.fn(async () => {}),
  loadUserAgentLimitsSettings: vi.fn(),
  saveUserAgentLimitsSettings: vi.fn(async (settings: unknown) => settings),
}));

const appearanceStore = vi.hoisted(() => ({
  loadAppearanceSettings: vi.fn(),
  saveAppearanceSettings: vi.fn(async (settings: unknown) => settings),
}));

vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  ...instructionRuntime,
  ...deviceRuntime,
}));

vi.mock("../../lib/shell-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/shell-store")>()),
  ...appearanceStore,
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

const managedPack = (
  patch: Partial<FleetManagedSettingsDocument["contextPacks"][number]> = {},
): FleetManagedSettingsDocument["contextPacks"][number] => ({
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
  ...patch,
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
  contextPacks: [managedPack()],
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

const appearance = {
  version: 1 as const,
  theme: "dark" as const,
  density: "compact" as const,
  accent: "sky" as const,
  showChangedFiles: true,
};

const limits = {
  infinite: false,
  executorTurns: 42,
  autopilotExecutorIterations: 7,
  automaticRetries: true,
  retryAttempts: 3,
};

const instruction = (
  id: string,
  name: string,
  body: string,
): FleetManagedSettingsDocument["instructions"][number] => ({
  id,
  name,
  body,
  enabled: true,
  global: true,
  tags: [],
});

/** The packs a plan manages, for state that predates origin tracking. */
const managedPacks = (
  value: FleetManagedSettingsDocument,
  currentPacks: SmartContextPack[],
  previouslyManagedIds: string[] = [],
): SmartContextPack[] => {
  const plan = planManagedContextPacks(value, currentPacks, "manager-one", {
    ...metadata,
    contextPackIds: previouslyManagedIds,
  });
  const ids = new Set(Object.values(plan.mappings));
  return plan.contextPacks.filter((pack) => ids.has(pack.id));
};

const uuid = (suffix: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + suffix).padStart(12, "0")}`;

describe("Fleet managed settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    library.profiles = [];
    library.revision = 1;
    library.failNames.clear();
    deviceRuntime.loadUserAgentLimitsSettings.mockResolvedValue(limits);
    appearanceStore.loadAppearanceSettings.mockResolvedValue(appearance);
  });

  it.each([true, false, undefined])(
    "captures portable local pack settings (%s) and excludes managed data",
    (enabled) => {
      const state = createInitialShellState();
      const local = document();
      const localId = uuid(0);
      const managedId = uuid(1);
      local.instructions = [localId, managedId].map((id) =>
        instruction(id, id, "Review"),
      );
      state.fleetManagedSettings = {
        ...metadata,
        instructionProfileIds: { source: managedId },
        contextPackIds: [managedId],
      };
      state.contextPacks = [
        {
          ...localPack(localId, "Local"),
          ...(enabled !== undefined
            ? {
                contextWindow: "lowest" as const,
                temporary: enabled,
                useWorkspaceMemory: !enabled,
              }
            : {}),
        },
        localPack(managedId, "Managed"),
        {
          ...localPack(uuid(2), "Workspace"),
          workspace: "C:\\Project",
        },
      ];
      const exported = createEnrollmentSettingsDocument(
        local,
        state,
        appearance,
        limits,
      );
      expect(
        exported.instructions.map((instruction) => instruction.id),
      ).toEqual([localId]);
      expect(exported.contextPacks.map((pack) => pack.id)).toEqual([localId]);
      const [imported] = managedPacks(exported, []);
      for (const pack of [exported.contextPacks[0], imported]) {
        if (enabled === undefined) {
          expect(pack).not.toHaveProperty("contextWindow");
          expect(pack).not.toHaveProperty("temporary");
          expect(pack).not.toHaveProperty("useWorkspaceMemory");
        } else {
          expect(pack).toMatchObject({
            contextWindow: "lowest" as const,
            temporary: enabled,
            useWorkspaceMemory: !enabled,
          });
        }
      }
      expect(exported.defaults).toMatchObject({
        theme: "dark",
        density: "compact",
      });
      expect(exported.agentLimits).toMatchObject({ executorTurns: 42 });
      expect(exported).not.toHaveProperty("secrets");
    },
  );

  it("exports the user's originals for settings the cloud took over", () => {
    const state = createInitialShellState();
    const takenId = uuid(3);
    const packId = uuid(4);
    state.lastSelectedProvider = "openai";
    state.lastSelectedModelByProvider = { openai: "gpt-5.6" };
    state.contextPacks = [
      { ...localPack(packId, "Review"), instructions: "Managed text" },
    ];
    state.fleetManagedSettings = {
      ...metadata,
      instructionProfileIds: { managed: takenId },
      ownedInstructionIds: [],
      instructionOriginals: {
        [takenId]: {
          name: "Code style",
          body: "My own style.",
          enabled: true,
          global: true,
          tags: [],
        },
      },
      contextPackIds: [packId],
      contextPackProfileIds: { "managed-pack": packId },
      ownedContextPackIds: [],
      contextPackOriginals: { [packId]: localPack(packId, "Review") },
      fieldOriginals: {
        model: { provider: "anthropic", model: "claude-opus-5-5" },
        theme: "light",
      },
      appliedFields: {
        model: { provider: "openai", model: "gpt-5.6" },
        theme: "dark",
      },
    };
    const local = document();
    local.instructions = [instruction(takenId, "Code style", "Managed style.")];
    const exported = createEnrollmentSettingsDocument(
      local,
      state,
      appearance,
      limits,
    );
    expect(exported.instructions).toEqual([
      instruction(takenId, "Code style", "My own style."),
    ]);
    expect(exported.contextPacks[0]).toMatchObject({
      id: packId,
      instructions: "Local instructions",
    });
    expect(exported.defaults).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      theme: "light",
      density: "compact",
    });
  });

  it("exports values the user changed after a default was applied", () => {
    const state = createInitialShellState();
    state.fleetManagedSettings = {
      ...metadata,
      fieldOriginals: { accent: "sky" },
      appliedFields: { accent: "violet" },
    };
    const exported = (accent: "violet" | "amber") =>
      createEnrollmentSettingsDocument(
        document(),
        state,
        { ...appearance, accent },
        limits,
      ).defaults.accent;
    // Still the cloud's value: the user's value from before is exported.
    expect(exported("violet")).toBe("sky");
    // Changed by the user afterwards: that choice is their own.
    expect(exported("amber")).toBe("amber");
  });

  it("leaves out items machdoch.cloud would reject instead of failing the upload", () => {
    const state = createInitialShellState();
    state.contextPacks = [
      { ...localPack(uuid(5), "Empty"), instructions: "", prompt: "" },
      localPack("context-pack-1", "Old id"),
      { ...localPack(uuid(6), "Provider only"), provider: "openai" },
    ];
    const exported = createEnrollmentSettingsDocument(
      document(),
      state,
      appearance,
      limits,
    );
    expect(exported.contextPacks).toEqual([
      expect.objectContaining({
        id: uuid(6),
        provider: null,
        model: null,
      }),
    ]);
  });

  it("creates managed packs first and keeps local packs", () => {
    const state = createInitialShellState();
    state.contextPacks = [
      localPack("local-pack", "Local pack"),
      localPack("fleet:manager-one:old-pack", "Old managed pack"),
    ];
    const previous = {
      ...metadata,
      revision: 1,
      contextPackIds: ["fleet:manager-one:old-pack"],
    };
    const plan = planManagedContextPacks(
      document(),
      state.contextPacks,
      "manager-one",
      previous,
    );
    const next = applyManagedShellSettings(
      state,
      plan.contextPacks,
      {
        model: { provider: "openai", model: "gpt-5.6" },
        mode: "ask",
        reasoning: "high",
      },
      { ...metadata, contextPackIds: Object.values(plan.mappings) },
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
    expect(plan.owned).toEqual(["fleet:manager-one:managed-pack"]);
    expect(next.lastSelectedProvider).toBe("openai");
    expect(next.lastSelectedModelByProvider.openai).toBe("gpt-5.6");
    expect(next.lastSelectedMode).toBe("ask");
    expect(next.lastSelectedReasoning).toBe("high");
  });

  it("links an identical local pack instead of duplicating it", () => {
    const [created] = managedPacks(document(), []);
    const own = { ...created!, id: "my-pack", useCount: 9 };
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    expect(plan.contextPacks).toEqual([own]);
    expect(plan.mappings).toEqual({ "managed-pack": "my-pack" });
    expect(plan.owned).toEqual([]);
    expect(plan.originals).toEqual({});
    const removed = planManagedContextPacks(
      null,
      plan.contextPacks,
      "manager-one",
      {
        ...metadata,
        contextPackProfileIds: plan.mappings,
        ownedContextPackIds: plan.owned,
        contextPackOriginals: plan.originals,
      },
    );
    expect(removed.contextPacks).toEqual([own]);
  });

  it("takes over a same-named local pack and restores it on removal", () => {
    const own = localPack("my-pack", "managed PACK");
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    expect(plan.contextPacks).toHaveLength(1);
    expect(plan.contextPacks[0]).toMatchObject({
      id: "my-pack",
      name: "Managed pack",
      instructions: "Managed instructions",
      useCount: 4,
    });
    expect(plan.originals).toEqual({ "my-pack": own });
    expect(plan.warnings).toEqual([expect.stringContaining("managed PACK")]);
    const state = {
      ...metadata,
      contextPackProfileIds: plan.mappings,
      ownedContextPackIds: plan.owned,
      contextPackOriginals: plan.originals,
    };
    // The notice stays while the takeover lasts, not only on the first sync.
    expect(
      planManagedContextPacks(
        document(),
        plan.contextPacks,
        "manager-one",
        state,
      ).warnings,
    ).toEqual([expect.stringContaining("managed PACK")]);
    const restored = planManagedContextPacks(
      null,
      plan.contextPacks,
      "manager-one",
      state,
    );
    expect(restored.contextPacks).toEqual([own]);
    expect(restored.originals).toEqual({});
  });

  it("keeps the user's original when a taken-over pack was edited locally", () => {
    const own = localPack("my-pack", "Managed pack");
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    const tracked = {
      ...metadata,
      contextPackProfileIds: plan.mappings,
      ownedContextPackIds: plan.owned,
      contextPackOriginals: plan.originals,
    };
    const edited = [{ ...plan.contextPacks[0]!, instructions: "Edited" }];
    const reapplied = planManagedContextPacks(
      document(),
      edited,
      "manager-one",
      tracked,
    );
    expect(reapplied.contextPacks[0]).toMatchObject({
      instructions: "Managed instructions",
    });
    expect(reapplied.originals).toEqual({ "my-pack": own });
  });

  it("drops the original when the user deleted a taken-over pack", () => {
    const own = localPack("my-pack", "Managed pack");
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    const tracked = {
      ...metadata,
      contextPackProfileIds: plan.mappings,
      ownedContextPackIds: plan.owned,
      contextPackOriginals: plan.originals,
    };
    const recreated = planManagedContextPacks(
      document(),
      [],
      "manager-one",
      tracked,
    );
    expect(recreated.contextPacks.map((pack) => pack.id)).toEqual([
      "fleet:manager-one:managed-pack",
    ]);
    expect(recreated.originals).toEqual({});
    expect(
      planManagedContextPacks(null, recreated.contextPacks, "manager-one", {
        ...tracked,
        contextPackProfileIds: recreated.mappings,
        ownedContextPackIds: recreated.owned,
        contextPackOriginals: recreated.originals,
      }).contextPacks,
    ).toEqual([]);
  });

  it("restores a pack under a free name when the user reused its name", () => {
    const own = localPack("my-pack", "Managed pack");
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    const newer = localPack("newer-pack", "managed pack");
    const restored = planManagedContextPacks(
      null,
      [...plan.contextPacks, newer],
      "manager-one",
      {
        ...metadata,
        contextPackProfileIds: plan.mappings,
        ownedContextPackIds: plan.owned,
        contextPackOriginals: plan.originals,
      },
    );
    expect(restored.contextPacks).toEqual([
      { ...own, name: "Managed pack (2)" },
      newer,
    ]);
  });

  it("never deletes packs when tracking lists no created packs", () => {
    const own = localPack("my-pack", "Managed pack");
    const plan = planManagedContextPacks(
      document(),
      [own],
      "manager-one",
      undefined,
    );
    // A damaged state without `ownedContextPackIds` is not treated as legacy.
    const removed = planManagedContextPacks(
      null,
      plan.contextPacks,
      "manager-one",
      {
        ...metadata,
        contextPackIds: Object.values(plan.mappings),
        contextPackProfileIds: plan.mappings,
        contextPackOriginals: plan.originals,
      },
    );
    expect(removed.contextPacks).toEqual([own]);
  });

  it("preserves usage metadata when a managed pack is revised", () => {
    const current = localPack(
      "fleet:manager-one:managed-pack",
      "Previous managed pack",
    );
    const [managed] = managedPacks(document(), [current], [current.id]);

    expect(managed).toMatchObject({
      id: "fleet:manager-one:managed-pack",
      createdAt: 10,
      lastUsedAt: 30,
      useCount: 4,
    });
  });

  it("warns instead of failing when a local pack uses the managed id", () => {
    const current = localPack("fleet:manager-one:managed-pack", "Local pack");
    const plan = planManagedContextPacks(
      document(),
      [current],
      "manager-one",
      undefined,
    );
    expect(plan.contextPacks).toEqual([current]);
    expect(plan.warnings).toEqual([
      expect.stringContaining("could not be applied"),
    ]);
  });

  it("reuses an unchanged managed pack", () => {
    const [first] = managedPacks(document(), []);
    if (!first) throw new Error("Managed pack was not created.");
    const [second] = managedPacks(document(), [first], [first.id]);

    expect(second).toBe(first);
  });

  it.each([
    { contextWindow: "lowest" as const },
    { temporary: true },
    { temporary: false },
    { useWorkspaceMemory: true },
    { useWorkspaceMemory: false },
  ])("detects changes to optional pack settings: %j", (settings) => {
    const [first] = managedPacks(document(), []);
    if (!first) throw new Error("Managed pack was not created.");
    const revised = document();
    revised.contextPacks = revised.contextPacks.map((pack) => ({
      ...pack,
      ...settings,
    }));
    const [second] = managedPacks(revised, [first], [first.id]);
    if (!second) throw new Error("Revised managed pack was not created.");
    expect(second).not.toBe(first);
    expect(second).toMatchObject(settings);
    const [unchanged] = managedPacks(revised, [second], [second.id]);
    expect(unchanged).toBe(second);
    const [reset] = managedPacks(document(), [second], [second.id]);
    expect(reset).not.toBe(second);
    expect(reset).not.toHaveProperty("contextWindow");
    expect(reset).not.toHaveProperty("temporary");
    expect(reset).not.toHaveProperty("useWorkspaceMemory");
  });

  describe("scalar settings", () => {
    const snapshot = (
      patch: Partial<FieldSnapshot> = {},
      theme: "dark" | "light" = "dark",
    ): FieldSnapshot => ({
      state: createInitialShellState(),
      appearance: { ...appearance, theme },
      webSearchProvider: "none",
      agentLimits: limits,
      ...patch,
    });
    const themed = (
      theme: "dark" | "light",
      enforced: boolean,
    ): FleetManagedSettingsDocument => {
      const value = document();
      value.defaults = {
        ...value.defaults,
        provider: null,
        model: null,
        mode: null,
        reasoning: null,
        theme,
      };
      value.policy = { enforced: enforced ? ["theme"] : [] };
      return value;
    };

    it("applies a default once so local changes stick", () => {
      const first = planManagedFields(
        themed("light", false),
        snapshot(),
        undefined,
      );
      expect(first.writes).toEqual({ theme: "light" });
      expect(first.fieldOriginals).toEqual({ theme: "dark" });
      const previous = { ...metadata, ...first };
      const second = planManagedFields(
        themed("light", false),
        snapshot({}, "dark"),
        previous,
      );
      expect(second.writes).toEqual({});
      const changed = planManagedFields(
        themed("dark", false),
        snapshot({}, "light"),
        { ...metadata, ...second },
      );
      expect(changed.writes).toEqual({ theme: "dark" });
    });

    it("re-applies enforced values every sync", () => {
      const first = planManagedFields(
        themed("light", true),
        snapshot(),
        undefined,
      );
      const second = planManagedFields(
        themed("light", true),
        snapshot({}, "dark"),
        { ...metadata, ...first },
      );
      expect(second.writes).toEqual({ theme: "light" });
      expect(second.fieldOriginals).toEqual({ theme: "dark" });
    });

    it("restores the original value unless the user changed it since", () => {
      const applied = planManagedFields(
        themed("light", true),
        snapshot(),
        undefined,
      );
      const restored = planManagedFields(null, snapshot({}, "light"), {
        ...metadata,
        ...applied,
      });
      expect(restored.writes).toEqual({ theme: "dark" });
      expect(restored.appliedFields).toEqual({});
      expect(restored.fieldOriginals).toEqual({});
      const changedLocally = planManagedFields(null, snapshot({}, "dark"), {
        ...metadata,
        appliedFields: { theme: "light" },
        fieldOriginals: { theme: "dark" },
      });
      expect(changedLocally.writes).toEqual({});
    });

    it("treats documents without a policy as enforced", () => {
      const legacy = themed("light", true);
      delete legacy.policy;
      const plan = planManagedFields(legacy, snapshot(), {
        ...metadata,
        appliedFields: { theme: "light" },
      });
      expect(plan.writes).toEqual({ theme: "light" });
    });
  });

  describe("instructions", () => {
    const managedId = uuid(10);
    const localId = uuid(11);

    it("links an identical local instruction without copying it", async () => {
      library.profiles = [
        { ...instruction(localId, "Code style", "Use tabs."), id: localId },
      ] as InstructionProfileView[];
      const result = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use tabs.")],
        undefined,
      );
      expect(library.profiles).toHaveLength(1);
      expect(result.mappings).toEqual({ [managedId]: localId });
      expect(result.owned).toEqual([]);
      expect(result.originals).toEqual({});
      expect(instructionRuntime.mutateInstructions).not.toHaveBeenCalled();
    });

    it("takes over a different local instruction and restores it on removal", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        undefined,
      );
      expect(library.profiles).toEqual([
        expect.objectContaining({ id: localId, body: "Use spaces." }),
      ]);
      expect(applied.originals[localId]).toMatchObject({ body: "Use tabs." });
      expect(applied.warnings).toEqual([expect.stringContaining("Code style")]);
      const removed = await synchronizeInstructions([], {
        ...metadata,
        instructionProfileIds: applied.mappings,
        ownedInstructionIds: applied.owned,
        instructionOriginals: applied.originals,
      });
      expect(library.profiles).toEqual([
        expect.objectContaining({ id: localId, body: "Use tabs." }),
      ]);
      expect(removed.originals).toEqual({});
    });

    it("deletes only instructions created for the cloud", async () => {
      library.profiles = [
        instruction(localId, "Mine", "Keep."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Security", "Be careful.")],
        undefined,
      );
      expect(applied.owned).toEqual([managedId]);
      await synchronizeInstructions([], {
        ...metadata,
        instructionProfileIds: applied.mappings,
        ownedInstructionIds: applied.owned,
        instructionOriginals: applied.originals,
      });
      expect(library.profiles.map((profile) => profile.id)).toEqual([localId]);
    });

    it("reports a failing item as a warning and applies the rest", async () => {
      library.failNames.add("Broken");
      const result = await synchronizeInstructions(
        [
          instruction(managedId, "Broken", "Fails."),
          instruction(localId, "Works", "Applied."),
        ],
        undefined,
      );
      expect(result.warnings).toEqual([expect.stringContaining("Broken")]);
      expect(library.profiles.map((profile) => profile.name)).toEqual([
        "Works",
      ]);
    });

    it("re-applies managed content over local edits and keeps the original", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        undefined,
      );
      library.profiles = [
        instruction(localId, "Code style", "Edited locally."),
      ] as InstructionProfileView[];
      const reapplied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        {
          ...metadata,
          instructionProfileIds: applied.mappings,
          ownedInstructionIds: applied.owned,
          instructionOriginals: applied.originals,
        },
      );
      expect(library.profiles).toEqual([
        expect.objectContaining({ id: localId, body: "Use spaces." }),
      ]);
      expect(reapplied.originals[localId]).toMatchObject({ body: "Use tabs." });
    });

    it("restores under a free name when the user reused the original name", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        undefined,
      );
      // machdoch.cloud renamed its version, then the user reused the name.
      const renamed = await synchronizeInstructions(
        [instruction(managedId, "Team style", "Use spaces.")],
        {
          ...metadata,
          instructionProfileIds: applied.mappings,
          ownedInstructionIds: applied.owned,
          instructionOriginals: applied.originals,
        },
      );
      const newerId = uuid(12);
      library.profiles.push(
        instruction(newerId, "code style", "Newer.") as InstructionProfileView,
      );
      const removed = await synchronizeInstructions([], {
        ...metadata,
        instructionProfileIds: renamed.mappings,
        ownedInstructionIds: renamed.owned,
        instructionOriginals: renamed.originals,
      });
      expect(removed.warnings).toEqual([]);
      expect(library.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: localId,
            name: "Code style (2)",
            body: "Use tabs.",
          }),
          expect.objectContaining({ id: newerId, name: "code style" }),
        ]),
      );
    });

    it("keeps tracking a profile whose restore failed and retries it", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        undefined,
      );
      const tracked = {
        ...metadata,
        instructionProfileIds: applied.mappings,
        ownedInstructionIds: applied.owned,
        instructionOriginals: applied.originals,
      };
      library.failNames.add("Code style");
      const failed = await synchronizeInstructions([], tracked);
      expect(failed.warnings).toEqual([
        expect.stringContaining("could not be restored"),
      ]);
      expect(failed.mappings).toEqual(applied.mappings);
      expect(failed.originals).toEqual(applied.originals);
      library.failNames.clear();
      const retried = await synchronizeInstructions([], {
        ...tracked,
        instructionProfileIds: failed.mappings,
        instructionOriginals: failed.originals,
      });
      expect(retried.mappings).toEqual({});
      expect(library.profiles).toEqual([
        expect.objectContaining({ id: localId, body: "Use tabs." }),
      ]);
    });

    it("treats instructions from state before origin tracking as created", async () => {
      library.profiles = [
        instruction(managedId, "Security", "Be careful."),
        instruction(localId, "Mine", "Keep."),
      ] as InstructionProfileView[];
      const removed = await synchronizeInstructions([], {
        ...metadata,
        instructionProfileIds: { [managedId]: managedId },
      });
      expect(removed.mappings).toEqual({});
      expect(library.profiles.map((profile) => profile.id)).toEqual([localId]);
    });

    it("drops the original when the user deleted a taken-over profile", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const applied = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        undefined,
      );
      library.profiles = [];
      const recreated = await synchronizeInstructions(
        [instruction(managedId, "Code style", "Use spaces.")],
        {
          ...metadata,
          instructionProfileIds: applied.mappings,
          ownedInstructionIds: applied.owned,
          instructionOriginals: applied.originals,
        },
      );
      expect(recreated.owned).toEqual([managedId]);
      expect(recreated.originals).toEqual({});
    });
  });

  describe("applying a delivery", () => {
    const managedId = uuid(20);
    const localId = uuid(21);
    const delivery = (value: FleetManagedSettingsDocument | null) => ({
      managerId: "manager-one",
      profile: value && {
        profileId: "profile-one",
        name: "Engineering",
        revision: 3,
        document: value,
        secrets: {},
      },
    });
    const harness = (initial = createInitialShellState()) => {
      let state: ShellPersistedState = initial;
      const environment: ManagedEnvironment = {
        applyShellState: (update) => {
          state = update(state);
        },
        applyLoadedAgentLimits: vi.fn(),
        refreshInstructions: vi.fn(async () => {}),
        readState: () => state,
      };
      return { environment, state: () => state };
    };
    const styled = (): FleetManagedSettingsDocument => ({
      ...document(),
      contextPacks: [],
      policy: { enforced: [] },
      instructions: [instruction(managedId, "Code style", "Use spaces.")],
    });

    it("keeps taken-over instructions restorable when a later step fails", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const { environment, state } = harness();
      deviceRuntime.loadUserAgentLimitsSettings.mockRejectedValueOnce(
        new Error("Settings are locked."),
      );
      await expect(
        applyManagedSettings(delivery(styled()), environment),
      ).rejects.toThrow("Settings are locked.");
      expect(state().fleetManagedSettings?.instructionOriginals).toEqual({
        [localId]: expect.objectContaining({ body: "Use tabs." }),
      });

      expect(await applyManagedSettings(delivery(null), environment)).toEqual(
        [],
      );
      expect(library.profiles).toEqual([
        expect.objectContaining({ id: localId, body: "Use tabs." }),
      ]);
      expect(state().fleetManagedSettings).toBeUndefined();
    });

    it("keeps tracking after unassignment while a restore keeps failing", async () => {
      library.profiles = [
        instruction(localId, "Code style", "Use tabs."),
      ] as InstructionProfileView[];
      const { environment, state } = harness();
      await applyManagedSettings(delivery(styled()), environment);
      library.failNames.add("Code style");
      const warnings = await applyManagedSettings(delivery(null), environment);
      expect(warnings).toEqual([
        expect.stringContaining("could not be restored"),
      ]);
      expect(state().fleetManagedSettings?.instructionProfileIds).toEqual({
        [managedId]: localId,
      });
    });

    it("turns failed writes and unsupported values into stable warnings", async () => {
      const { environment, state } = harness();
      const value: FleetManagedSettingsDocument = {
        ...document(),
        contextPacks: [
          managedPack({ provider: "unknown" as "openai", model: "x" }),
        ],
        defaults: { ...document().defaults, theme: "light" },
        policy: { enforced: [] },
      };
      const diskFull = new Error("Disk full.");
      const readOnly = new Error("Prompt folder is read-only.");
      appearanceStore.saveAppearanceSettings
        .mockRejectedValueOnce(diskFull)
        .mockRejectedValueOnce(diskFull);
      deviceRuntime.synchronizeFleetManagedPrompts
        .mockRejectedValueOnce(readOnly)
        .mockRejectedValueOnce(readOnly);
      const first = await applyManagedSettings(delivery(value), environment);
      expect(first).toEqual([
        "Prompts could not be applied: Prompt folder is read-only.",
        'Context pack "Managed pack" uses settings this version of machdoch does not support.',
        "Appearance settings could not be applied: Disk full.",
      ]);
      // The theme was not written, so it is not tracked and is retried.
      expect(state().fleetManagedSettings?.appliedFields).not.toHaveProperty(
        "theme",
      );
      expect(state().lastSelectedMode).toBe("ask");
      expect(await applyManagedSettings(delivery(value), environment)).toEqual(
        first,
      );
    });

    it("releases keys an older desktop copied into the user config", async () => {
      const initial = createInitialShellState();
      initial.fleetManagedSettings = {
        ...metadata,
        contextPackIds: [],
        secretIds: ["openai", "anthropic"],
      };
      const { environment, state } = harness(initial);
      const value = { ...document(), contextPacks: [] };
      await applyManagedSettings(
        {
          managerId: "manager-one",
          profile: {
            profileId: "profile-one",
            name: "Engineering",
            revision: 3,
            document: value,
            secrets: { openai: "sk-managed" },
          },
        },
        environment,
      );
      expect(deviceRuntime.releaseFleetManagedApiKeys).toHaveBeenCalledWith({
        openai: "sk-managed",
      });
      expect(deviceRuntime.deleteUserProviderApiKey).toHaveBeenCalledWith(
        "anthropic",
      );
      expect(state().fleetManagedSettings?.secretIds).toEqual([]);
    });

    it("writes managed limits over the stored limits, not unloaded defaults", async () => {
      const { environment } = harness();
      const value = { ...document(), contextPacks: [] };
      value.agentLimits = { ...value.agentLimits, executorTurns: 9 };
      await applyManagedSettings(delivery(value), environment);
      expect(deviceRuntime.saveUserAgentLimitsSettings).toHaveBeenCalledWith({
        ...limits,
        executorTurns: 9,
      });
      expect(environment.applyLoadedAgentLimits).toHaveBeenCalledOnce();
    });
  });

  it("queues one sync behind a running one and serializes uploads", async () => {
    const queue = createSyncQueue();
    const order: string[] = [];
    let release = (): void => {};
    const running = queue.sync(
      () =>
        new Promise<void>((resolve) => {
          order.push("first sync");
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(order).toEqual(["first sync"]));
    const queued = queue.sync(async () => {
      order.push("second sync");
    });
    const merged = queue.sync(async () => {
      order.push("merged sync");
    });
    const upload = queue.exclusive(async () => {
      order.push("upload");
    });
    release();
    await Promise.all([running, queued, merged, upload]);
    expect(order).toEqual(["first sync", "second sync", "upload"]);
  });
});
