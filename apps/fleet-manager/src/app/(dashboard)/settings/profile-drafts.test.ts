import { describe, expect, it } from "vitest";
import {
  createProfileDraft,
  hasProfileDraftChanges,
  prepareGeneralProfileSave,
  profileDraftsReducer,
  receiveProfileResponse,
} from "./profile-drafts";
import type { ProfileDrafts, ProfileGeneralDraft } from "./profile-drafts";
import type { SettingsProfile } from "./types";

function profile(profileId = "a", revision = 1): SettingsProfile {
  return {
    profileId,
    revision,
    name: `Profile ${profileId}`,
    description: "Description",
    document: {
      defaults: {
        provider: "openai",
        model: "model",
        mode: "ask",
        reasoning: "high",
        webSearchProvider: "none",
        theme: "dark",
        density: "compact",
        accent: "sky",
      },
      agentLimits: {
        infinite: false,
        executorTurns: 10,
        autopilotExecutorIterations: 20,
      },
      instructions: [],
      contextPacks: [],
      prompts: [],
    },
    secrets: [{ secretId: "openai", lastFour: "1234", updatedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function edit(state: ProfileDrafts, draft: ProfileGeneralDraft): ProfileDrafts {
  return profileDraftsReducer(state, {
    type: "changed",
    draft,
    values: {
      name: "Unsaved name",
      description: "Unsaved description",
      defaults: {
        provider: "anthropic",
        model: "typed model ",
        mode: "machdoch",
        reasoning: "low",
        webSearchProvider: "tavily",
        theme: "light",
        density: "comfortable",
        accent: "violet",
      },
      agentLimits: {
        infinite: "true",
        executorTurns: "",
        autopilotExecutorIterations: "42",
      },
    },
  });
}

describe("profile general drafts", () => {
  it("restores every edited value after selecting A, B, and A", () => {
    const a = profile();
    let state = profileDraftsReducer({}, { type: "loaded", profile: a });
    state = edit(state, state.a!);
    const edited = state.a;
    state = profileDraftsReducer(state, {
      type: "loaded",
      profile: profile("b"),
    });
    state = edit(state, state.b!);
    const editedB = state.b;
    state = profileDraftsReducer(state, { type: "loaded", profile: a });
    expect(state.a).toEqual(edited);
    expect(state.b).toEqual(editedB);
    expect(state.a!.values.name).toBe("Unsaved name");
    expect(state.a!.baseRevision).toBe(1);
  });

  it("keeps unsaved values and the original revision when the server changes", () => {
    const a = profile();
    let state = edit({}, createProfileDraft(a));
    const edited = state.a;
    const changed = { ...profile("a", 2), name: "Server name" };
    state = profileDraftsReducer(state, { type: "loaded", profile: changed });
    expect(state.a).toEqual(edited);
    expect(() => prepareGeneralProfileSave(changed, state.a!)).toThrow(
      /reload/i,
    );
    expect(() => prepareGeneralProfileSave(profile("b"), state.a!)).toThrow(
      /reload/i,
    );
  });

  it("refreshes a clean draft from the server, including after edits are undone", () => {
    const a = profile();
    let state = edit({}, createProfileDraft(a));
    state = profileDraftsReducer(state, {
      type: "changed",
      draft: state.a!,
      values: state.a!.baseline,
    });
    expect(hasProfileDraftChanges(state.a!)).toBe(false);
    const changed = { ...profile("a", 2), name: "Server name" };
    state = profileDraftsReducer(state, { type: "loaded", profile: changed });
    expect(state.a).toEqual(createProfileDraft(changed));
  });

  it("establishes accepted server values as the baseline after a general save", () => {
    const a = profile();
    let state = edit({}, createProfileDraft(a));
    state = edit(state, createProfileDraft(profile("b")));
    const editedB = state.b;
    const request = prepareGeneralProfileSave(a, state.a!);
    const accepted = { ...a, ...request, revision: 2, name: "Accepted name" };
    state = profileDraftsReducer(state, { type: "saved", profile: accepted });
    expect(state.a).toEqual(createProfileDraft(accepted));
    expect(hasProfileDraftChanges(state.a!)).toBe(false);
    expect(state.b).toBe(editedB);
    expect(prepareGeneralProfileSave(accepted, state.a!).expectedRevision).toBe(
      2,
    );
  });

  it("discards only the reloaded profile after confirmation and a successful read", () => {
    let state = edit({}, createProfileDraft(profile()));
    state = edit(state, createProfileDraft(profile("b")));
    const editedB = state.b;
    const reloaded = profile("a", 3);
    state = profileDraftsReducer(state, {
      type: "reloaded",
      profile: reloaded,
    });
    expect(state.a).toEqual(createProfileDraft(reloaded));
    expect(state.b).toBe(editedB);
  });

  it("removes only the successfully deleted profile", () => {
    let state = edit({}, createProfileDraft(profile()));
    state = edit(state, createProfileDraft(profile("b")));
    const editedB = state.b;
    state = profileDraftsReducer(state, { type: "deleted", profileId: "a" });
    expect(state.a).toBeUndefined();
    expect(state.b).toBe(editedB);
  });

  it("retains drafts when load, save, or reload fail, then accepts a successful retry", async () => {
    let state = edit({}, createProfileDraft(profile()));
    const edited = state.a;
    const onProfile = (next: SettingsProfile) => {
      state = profileDraftsReducer(state, { type: "loaded", profile: next });
    };
    for (const type of ["loaded", "saved", "reloaded"] as const) {
      const onDraftAccepted =
        type === "loaded"
          ? undefined
          : (next: SettingsProfile) => {
              state = profileDraftsReducer(state, { type, profile: next });
            };
      await expect(
        receiveProfileResponse(
          Promise.reject(new Error("Request failed")),
          onProfile,
          onDraftAccepted,
        ),
      ).rejects.toThrow("Request failed");
      expect(state.a).toBe(edited);
    }
    await receiveProfileResponse(
      Promise.resolve({ profile: profile() }),
      onProfile,
    );
    expect(state.a).toBe(edited);
    const accepted = profile("a", 2);
    await receiveProfileResponse(
      Promise.resolve({ profile: accepted }),
      onProfile,
      (next) => {
        state = profileDraftsReducer(state, { type: "saved", profile: next });
        expect(state.a).toEqual(createProfileDraft(accepted));
      },
    );
    expect(state.a).toEqual(createProfileDraft(accepted));
  });

  it("keeps only general values and does not alias server defaults or limits", () => {
    const a = profile();
    const draft = createProfileDraft(a);
    expect(Object.keys(draft).sort()).toEqual([
      "baseRevision",
      "baseline",
      "profileId",
      "values",
    ]);
    expect(Object.keys(draft.values).sort()).toEqual([
      "agentLimits",
      "defaults",
      "description",
      "name",
    ]);
    a.document.defaults.model = "Changed on server";
    a.document.agentLimits.executorTurns = 100;
    expect(draft.values.defaults.model).toBe("model");
    expect(draft.values.agentLimits.executorTurns).toBe("10");
    expect(JSON.stringify(draft)).not.toContain("1234");
  });

  it("builds a revision-bound save without changing other profile collections", () => {
    const a = profile();
    a.document.prompts.push({
      id: "prompt",
      relativePath: "prompt.md",
      content: "Keep me",
    });
    const state = edit({}, createProfileDraft(a));
    const request = prepareGeneralProfileSave(a, state.a!);
    expect(request.expectedRevision).toBe(1);
    expect(request.name).toBe("Unsaved name");
    expect(request.description).toBe("Unsaved description");
    expect(request.document.defaults.model).toBe("typed model");
    expect(request.document.defaults).toEqual({
      provider: "anthropic",
      model: "typed model",
      mode: "machdoch",
      reasoning: "low",
      webSearchProvider: "tavily",
      theme: "light",
      density: "comfortable",
      accent: "violet",
    });
    expect(request.document.agentLimits).toEqual({
      infinite: true,
      executorTurns: null,
      autopilotExecutorIterations: 42,
    });
    expect(request.document.prompts).toEqual(a.document.prompts);
    expect(a.document.defaults.model).toBe("model");
    expect(state.a!.values.defaults.model).toBe("typed model ");
  });

  it("preserves a typed model while the provider is unset and omits it from the save", () => {
    const a = profile();
    const draft = createProfileDraft(a);
    draft.values = {
      ...draft.values,
      defaults: {
        ...draft.values.defaults,
        provider: "",
        model: "typed model",
      },
    };
    expect(
      prepareGeneralProfileSave(a, draft).document.defaults.model,
    ).toBeNull();
    expect(draft.values.defaults.model).toBe("typed model");
    draft.values.defaults.provider = "openai";
    expect(prepareGeneralProfileSave(a, draft).document.defaults.model).toBe(
      "typed model",
    );
  });

  it("preserves edits through an accepted update to another profile section", () => {
    const a = profile();
    const state = edit({}, createProfileDraft(a));
    const changed = profile("a", 2);
    changed.document.instructions.push({
      id: "instruction",
      name: "New",
      body: "Body",
      enabled: true,
      global: false,
      tags: [],
    });
    const received = profileDraftsReducer(state, {
      type: "loaded",
      profile: changed,
    });
    expect(received.a).toBe(state.a);
    expect(() => prepareGeneralProfileSave(changed, received.a!)).toThrow(
      /reload/i,
    );
    const reloaded = profileDraftsReducer(received, {
      type: "reloaded",
      profile: changed,
    });
    expect(
      prepareGeneralProfileSave(changed, reloaded.a!).document.instructions,
    ).toEqual(changed.document.instructions);
  });

  it("round-trips unset defaults and limits without turning false into null", () => {
    const a = profile();
    a.document.defaults = {
      provider: null,
      model: null,
      mode: null,
      reasoning: null,
      webSearchProvider: null,
      theme: null,
      density: null,
      accent: null,
    };
    a.document.agentLimits = {
      infinite: null,
      executorTurns: null,
      autopilotExecutorIterations: null,
    };
    const draft = createProfileDraft(a);
    expect(draft.values.agentLimits.infinite).toBe("");
    expect(prepareGeneralProfileSave(a, draft).document).toEqual(a.document);
    draft.values = {
      ...draft.values,
      agentLimits: { ...draft.values.agentLimits, infinite: "false" },
    };
    expect(
      prepareGeneralProfileSave(a, draft).document.agentLimits.infinite,
    ).toBe(false);
  });
});
