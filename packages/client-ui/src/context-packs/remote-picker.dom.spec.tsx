import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerDraftStore } from "@machdoch/product-ui/composer-controls";
import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import type { SmartContextPackPickerProps } from "./picker";
import type { SmartContextPack } from "./model";
import {
  RemoteContextPackPicker,
  type RemoteContextPackPickerProps,
} from "./remote-picker";

const latest = vi.hoisted(() => ({
  props: null as SmartContextPackPickerProps | null,
}));
vi.mock("./picker", () => ({
  SmartContextPackPicker: (props: SmartContextPackPickerProps) => {
    latest.props = props;
    return <button disabled={props.disabled}>Context packs</button>;
  },
}));

function pack(name: string): SmartContextPack {
  return {
    id: name,
    name,
    workspace: null,
    instructions: "Use {{name}}",
    prompt: "Hello {{name}}",
    contextAttachments: [],
    variables: [{ name: "name", defaultValue: "World" }],
    trigger: { phrases: [], pathPatterns: [] },
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
  };
}

function picker(): SmartContextPackPickerProps {
  if (!latest.props) throw new Error("Picker was not rendered.");
  return latest.props;
}

function props(
  invoke = vi.fn().mockResolvedValue([]),
): RemoteContextPackPickerProps {
  const composer: RemoteContextPackPickerProps["composer"] = {
    sessionId: "session-1",
    draft: "",
    provider: "openai",
    providerLabel: "OpenAI",
    model: "test-model",
    modelLabel: "Test model",
    modelCatalogLoading: false,
    modelCatalog: [],
    mode: "machdoch",
    defaultMode: "machdoch",
    reasoning: "default",
    defaultReasoning: "default",
    reasoningOptions: ["default"],
    promptEnhancementMode: "off",
    interviewEnabled: false,
    interviewAvailable: true,
    workspaceLabel: "Workspace",
    canSend: true,
    isExecuting: false,
    sessionMemoryEnabled: false,
    sessionMemory: [],
    globalMemoryAvailable: true,
    globalMemoryEnabled: true,
    uiControlAvailable: false,
    uiControlEnabled: false,
    uiControlDescription: "",
    attachments: [],
    chooserProviders: [],
    matchedContextPackIds: [],
  };
  return {
    session: {
      id: composer.sessionId,
      title: "Remote session",
      status: "idle",
      provider: composer.provider,
      model: composer.model,
      effectiveMode: composer.mode,
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      messageCount: 0,
      promptHistoryCount: 0,
      attachmentCount: 0,
      canRename: true,
      canDelete: true,
      canArchive: true,
      canPin: true,
      canDuplicate: true,
      canBranch: true,
    },
    composer: { ...composer, provider: "openai", globalMemoryEnabled: true },
    contextPacks: [],
    workspaces: [],
    webSearchAvailable: false,
    canCancel: false,
    drafts: createComposerDraftStore(),
    activeDraft: "Unsaved browser draft",
    pending: false,
    onCommand: vi.fn().mockResolvedValue(true),
    workspaceTransport: { invoke } as unknown as FleetOperationTransport,
    ralphTransport: {
      invoke: vi.fn().mockResolvedValue({ flows: [] }),
    } as unknown as FleetOperationTransport,
    mediaTransport: {
      upload: vi.fn().mockResolvedValue("granted-upload"),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as FleetMediaTransport,
  };
}

afterEach(() => {
  cleanup();
  latest.props = null;
});

describe("remote context-pack controls", () => {
  it("waits for the browser draft to persist before applying a pack and accepts the native draft", async () => {
    const controls = props();
    let acknowledgeDraft!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledgeDraft = resolve;
    });
    controls.drafts.sessions.set(controls.session.id, {
      text: "Browser draft",
      revision: 1,
      pending,
      error: null,
      failedSubmission: null,
    });
    render(<RemoteContextPackPicker {...controls} />);
    await waitFor(() => expect(picker().disabled).toBe(false));
    const applying = picker().onApplyContextPack("Shared");
    expect(controls.onCommand).not.toHaveBeenCalled();
    await act(async () => {
      acknowledgeDraft();
      await applying;
    });
    expect(controls.onCommand).toHaveBeenCalledWith({
      kind: "apply-context-pack",
      sessionId: controls.session.id,
      contextPackId: "Shared",
    });
    expect(controls.drafts.sessions.has(controls.session.id)).toBe(false);
    expect(controls.drafts.getRevision()).toBe(1);
  });

  it("preserves a newer draft while a context-pack application is acknowledged", async () => {
    const controls = props();
    let acknowledgePack!: (accepted: boolean) => void;
    vi.mocked(controls.onCommand).mockReturnValue(
      new Promise((resolve) => {
        acknowledgePack = resolve;
      }),
    );
    const entry = {
      text: "Browser draft",
      revision: 1,
      pending: Promise.resolve(),
      error: null,
      failedSubmission: null,
    };
    controls.drafts.sessions.set(controls.session.id, entry);
    render(<RemoteContextPackPicker {...controls} />);
    await waitFor(() => expect(picker().disabled).toBe(false));
    const applying = picker().onApplyContextPack("Shared");
    await waitFor(() => expect(controls.onCommand).toHaveBeenCalledTimes(1));
    entry.text = "Newer browser draft";
    entry.revision += 1;
    await act(async () => {
      acknowledgePack(true);
      await applying;
    });
    expect(controls.drafts.sessions.get(controls.session.id)?.text).toBe(
      "Newer browser draft",
    );
  });

  it("asks for another apply when the draft changes while waiting for persistence", async () => {
    const controls = props();
    let acknowledgeDraft!: () => void;
    const entry = {
      text: "Browser draft",
      revision: 1,
      pending: new Promise<void>((resolve) => {
        acknowledgeDraft = resolve;
      }),
      error: null,
      failedSubmission: null,
    };
    controls.drafts.sessions.set(controls.session.id, entry);
    render(<RemoteContextPackPicker {...controls} />);
    await waitFor(() => expect(picker().disabled).toBe(false));
    const applying = picker().onApplyContextPack("Shared");
    const failed = expect(applying).rejects.toThrow("draft changed");
    entry.text = "Newer browser draft";
    entry.revision += 1;
    acknowledgeDraft();
    await failed;
    expect(controls.onCommand).not.toHaveBeenCalled();
    expect(controls.drafts.sessions.get(controls.session.id)).toBe(entry);
  });

  it("keeps the browser draft and actual memory setting, applies variables, and refreshes after mutations", async () => {
    const controls = props(vi.fn().mockResolvedValue([pack("Shared")]));
    render(<RemoteContextPackPicker {...controls} />);
    await waitFor(() => expect(picker().disabled).toBe(false));
    expect(picker().activeDraft).toBe("Unsaved browser draft");
    expect(picker().activeUseGlobalMemory).toBe(true);
    await act(() => picker().onApplyContextPack("Shared", { name: "Grüß 🌿" }));
    expect(controls.onCommand).toHaveBeenCalledWith({
      kind: "apply-context-pack",
      sessionId: controls.session.id,
      contextPackId: "Shared",
      variableValues: { name: "Grüß 🌿" },
    });
    await waitFor(() =>
      expect(controls.workspaceTransport.invoke).toHaveBeenCalledTimes(2),
    );
    expect(picker().contextPacks[0]?.instructions).toBe("Use {{name}}");
  });

  it("ignores delayed documents from a workspace the user has left", async () => {
    let resolveOld!: (value: SmartContextPack[]) => void;
    const old = new Promise<SmartContextPack[]>((resolve) => {
      resolveOld = resolve;
    });
    const controls = props(
      vi
        .fn()
        .mockReturnValueOnce(old)
        .mockResolvedValue([pack("New workspace")]),
    );
    const view = render(<RemoteContextPackPicker {...controls} />);
    expect(picker().disabled).toBe(true);
    view.rerender(
      <RemoteContextPackPicker
        {...controls}
        session={{ ...controls.session, workspace: "/new-workspace" }}
      />,
    );
    await waitFor(() =>
      expect(picker().contextPacks[0]?.name).toBe("New workspace"),
    );
    await act(async () => resolveOld([pack("Old workspace")]));
    expect(picker().contextPacks[0]?.name).toBe("New workspace");
  });

  it("releases an uploaded archive after a failed native import and rejects invalid files before upload", async () => {
    const controls = props();
    render(<RemoteContextPackPicker {...controls} />);
    await waitFor(() => expect(picker().disabled).toBe(false));
    vi.mocked(controls.onCommand).mockResolvedValue(false);
    const payload = JSON.stringify({
      kind: "machdoch.context-packs",
      version: 1,
      exportedAt: 1,
      contextPacks: [pack("Imported")],
    });
    const file = { name: "packs.json", text: async () => payload } as File;
    await expect(picker().onImportContextPacks(file, "global")).rejects.toThrow(
      "change failed",
    );
    expect(controls.onCommand).toHaveBeenCalledWith({
      kind: "import-context-packs",
      sessionId: controls.session.id,
      scope: "global",
      paths: ["granted-upload"],
    });
    expect(controls.mediaTransport.release).toHaveBeenCalledWith(
      "granted-upload",
    );
    const invalid = { name: "invalid.json", text: async () => "{}" } as File;
    await expect(
      picker().onImportContextPacks(invalid, "global"),
    ).rejects.toThrow();
    expect(controls.mediaTransport.upload).toHaveBeenCalledTimes(1);
  });
});
