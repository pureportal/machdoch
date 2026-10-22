import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  createSession,
  normalizeShellState,
} from "../../chat-session.model";
import type { SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import {
  contextPackDocumentSchema,
  contextPackExportSchema,
} from "@machdoch/fleet-protocol/context-pack-contract";
import { createSmartContextPackExportPayload } from "@machdoch/client-ui/context-packs/helpers";
import {
  applySmartContextPackSettingsToSession,
  applySmartContextPackSettingsToShellDefaults,
  importSmartContextPacksIntoShellState,
} from "./smart-context-packs";
import {
  createSessionMessageSettings,
  applySessionMessageSettings,
} from "./session-message-settings";
import { resetTemporaryContextPackSettings } from "./temporary-context-pack";
import { getSessionMessageRunningAction } from "./composer-submission";
import { mergeShellStateForPersistence } from "./use-chat-session-shell-state";

const pack: SmartContextPack = {
  id: "commit",
  name: "Commit and push",
  workspace: null,
  instructions: "",
  prompt: "Commit and push",
  contextAttachments: [],
  variables: [],
  trigger: { phrases: [], pathPatterns: [] },
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
  temporary: true,
  provider: "codex-cli",
  model: "gpt-6.1-sol",
  mode: "machdoch",
  reasoning: "low",
  sessionMemoryEnabled: false,
  useGlobalMemory: false,
  useWorkspaceMemory: false,
  uiControlEnabled: false,
  promptEnhancementMode: "off",
  interviewEnabled: false,
};
const selection = { provider: pack.provider!, model: pack.model! };
const base = () =>
  createSession({
    id: "session",
    provider: "codex-cli",
    model: "gpt-6-astra",
    draft: "Commit and push",
    mode: "ask",
    reasoning: "high",
    sessionMemoryEnabled: true,
    useGlobalMemory: true,
    useWorkspaceMemory: true,
    uiControlEnabled: true,
  });

describe("temporary context pack settings", () => {
  it.each(["queue", "stop-and-send"] as const)(
    "preserves the %s action when a temporary pack changes the model",
    (runningAction) => {
      const applied = applySmartContextPackSettingsToSession(
        base(),
        pack,
        selection,
      );
      expect(
        getSessionMessageRunningAction({
          session: applied,
          activeTaskId: "running",
          unsettledTaskId: null,
          runningAction,
        }),
      ).toBe(runningAction);
    },
  );

  it("retains a reset when another window updates unrelated session fields", () => {
    const original = base();
    const applied = applySmartContextPackSettingsToSession(
      original,
      pack,
      selection,
    );
    const state = {
      ...createInitialShellState(),
      activeSessionId: applied.id,
      sessions: [applied],
    };
    const local = {
      ...state,
      sessions: [
        {
          ...resetTemporaryContextPackSettings(applied),
          updatedAt: applied.updatedAt + 1,
        },
      ],
    };
    const external = {
      ...state,
      sessions: [
        {
          ...applied,
          manualTitle: "Renamed",
          updatedAt: applied.updatedAt + 2,
        },
      ],
    };
    const merged = mergeShellStateForPersistence(local, state, external);
    expect(merged.sessions[0]?.temporaryPackSettings).toBeUndefined();
    expect(merged.sessions[0]?.model).toBe(original.model);
    expect(merged.sessions[0]?.manualTitle).toBe("Renamed");
  });

  it("restores the previous model and settings without touching the draft or messages", () => {
    const original = base();
    const applied = applySmartContextPackSettingsToSession(
      original,
      pack,
      selection,
    );
    expect(applied.model).toBe(pack.model);
    expect(applied.sessionMemoryEnabled).toBe(false);
    expect(applied.temporaryPackSettings).toMatchObject({
      packName: pack.name,
      promptEnhancementMode: "off",
      interviewEnabled: false,
    });
    expect(resetTemporaryContextPackSettings(applied)).toEqual(original);
    expect(original.temporaryPackSettings).toBeUndefined();
  });

  it("does not write temporary choices into future-chat defaults", () => {
    const state = createInitialShellState();
    expect(
      applySmartContextPackSettingsToShellDefaults(state, pack, selection),
    ).toBe(state);
  });

  it("returns to the original baseline when a temporary pack replaces another", () => {
    const original = base();
    const first = applySmartContextPackSettingsToSession(
      original,
      pack,
      selection,
    );
    const second = applySmartContextPackSettingsToSession(
      first,
      { ...pack, model: "other" },
      { ...selection, model: "other" },
    );
    expect(second.model).toBe("other");
    expect(resetTemporaryContextPackSettings(second)).toEqual(original);
  });

  it("preserves deliberate setting changes made after applying a pack", () => {
    const applied = applySmartContextPackSettingsToSession(
      base(),
      pack,
      selection,
    );
    const restored = resetTemporaryContextPackSettings({
      ...applied,
      model: "manually-selected",
      reasoning: "medium",
      useGlobalMemory: true,
    });
    expect(restored).toMatchObject({
      model: "manually-selected",
      reasoning: "medium",
      useGlobalMemory: true,
      sessionMemoryEnabled: true,
    });
    expect(restored.temporaryPackSettings).toBeUndefined();
  });

  it("removes the temporary state when a persistent pack is applied", () => {
    const applied = applySmartContextPackSettingsToSession(
      base(),
      pack,
      selection,
    );
    const persistent = applySmartContextPackSettingsToSession(
      applied,
      { ...pack, temporary: false },
      selection,
    );
    expect(persistent.model).toBe(pack.model);
    expect(resetTemporaryContextPackSettings(persistent)).toBe(persistent);
  });

  it("restores absent mode and reasoning overrides", () => {
    const original = createSession({
      provider: "codex-cli",
      model: "gpt-6-astra",
    });
    const restored = resetTemporaryContextPackSettings(
      applySmartContextPackSettingsToSession(original, pack, selection),
    );
    expect(restored.mode).toBeUndefined();
    expect(restored.reasoning).toBeUndefined();
  });

  it("retains reset state and queued execution settings through persistence", () => {
    const original = base();
    const applied = applySmartContextPackSettingsToSession(
      original,
      pack,
      selection,
    );
    const settings = createSessionMessageSettings(applied);
    const state = createInitialShellState();
    const saved = normalizeShellState(
      JSON.parse(
        JSON.stringify({
          ...state,
          activeSessionId: original.id,
          sessions: [applied],
          queuedSessionMessages: [
            {
              id: "queued",
              sessionId: original.id,
              task: "Commit",
              settings,
              contextAttachments: [],
              createdAt: 1,
              updatedAt: 1,
              contentUpdatedAt: 1,
              attachmentsUpdatedAt: 1,
              attachmentTombstones: {},
              blockerUpdatedAt: 1,
              orderRank: 0,
              orderUpdatedAt: 1,
              status: "queued",
              statusUpdatedAt: 1,
            },
          ],
        }),
      ),
    );
    const restored = resetTemporaryContextPackSettings(saved.sessions[0]!);
    expect(restored.model).toBe(original.model);
    expect(saved.queuedSessionMessages[0]?.settings?.model).toBe(pack.model);
    const execution = applySessionMessageSettings(
      restored,
      saved.queuedSessionMessages[0]!.settings!,
    );
    expect(execution.model).toBe(pack.model);
    expect(createSessionMessageSettings(restored).model).toBe(original.model);
  });

  it("round-trips the temporary flag in exported packs", () => {
    expect(contextPackDocumentSchema.parse(pack).temporary).toBe(true);
    const payload = createSmartContextPackExportPayload([pack]);
    expect(
      contextPackExportSchema.parse(payload).contextPacks[0]?.temporary,
    ).toBe(true);
    const imported = importSmartContextPacksIntoShellState(
      createInitialShellState(),
      payload,
      null,
      "global",
    );
    expect(imported.contextPacks[0]?.temporary).toBe(true);
    expect(
      contextPackDocumentSchema.safeParse({ ...pack, temporary: "yes" })
        .success,
    ).toBe(false);
  });
});
