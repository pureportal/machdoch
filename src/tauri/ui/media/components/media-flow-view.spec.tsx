import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMediaModelCatalog } from "../../../../core/media/catalog.js";
import {
  compileMediaFlow,
  createSubjectCutoutFlow,
  createImageEditFlow,
  createImageRecipeFlow,
  createMediaFlowLayout,
} from "../../../../core/media/compiler.js";
import type {
  MediaAssetRecord,
  MediaFlow,
  MediaFlowHistory,
  MediaFlowImportInspection,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { instantiateMediaFlowTemplate } from "../../../../core/media/templates.js";
import * as mediaRuntime from "../media-runtime";
import { MediaFlowView } from "./media-flow-view";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({
    children,
    nodes,
    onNodeClick,
  }: {
    children: ReactNode;
    nodes: Array<{
      id: string;
      data: {
        label: string;
        asset?: MediaAssetRecord | null;
        assetLabel?: string | null;
      };
    }>;
    onNodeClick: (event: unknown, node: { id: string }) => void;
  }) => (
    <div aria-label="Editable semantic media workflow">
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-asset-id={node.data.asset?.id}
          data-asset-label={node.data.assetLabel ?? undefined}
          onClick={() => onNodeClick(undefined, node)}
        >
          Select {node.data.label}
        </button>
      ))}
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useNodesState: <T,>(nodes: T[]) => [nodes, vi.fn(), vi.fn()],
}));

const flow = createImageRecipeFlow({
  id: "flow:view-test",
  createdAt: "2026-07-14T08:00:00.000Z",
  settings: {
    prompt: "A revision history interface",
    providerPolicy: "auto",
    modelPolicy: "balanced",
    modelId: null,
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
    qualityGateEnabled: false,
    referenceImages: [],
    modelAddons: [],
  },
});
const layout = createMediaFlowLayout(flow);
const models = createMediaModelCatalog({ isOpenAiConfigured: true });
const createAsset = (id: string, digest: string): MediaAssetRecord => ({
  id,
  runId: "run:asset-picker",
  digest,
  kind: "image",
  mimeType: "image/png",
  byteSize: 1_024,
  width: 1_024,
  height: 1_024,
  createdAt: "2026-07-14T08:00:00.000Z",
  outputIndex: 0,
  fixture: true,
  operation: null,
  sourceAssetIds: [],
  tags: [],
});
const plan = compileMediaFlow({
  flow,
  models,
  compiledAt: "2026-07-14T08:01:00.000Z",
});
const revision = {
  schemaVersion: 1 as const,
  revisionId: "mfr-test-1",
  flowId: flow.id,
  revisionNumber: 1,
  parentRevisionId: null,
  createdAt: "2026-07-14T08:00:00.000Z",
  changeSummary: "Initial revision",
  documentDigest: "sha256:document-1",
  executionDigest: "sha256:execution-1",
  layoutDigest: "sha256:layout-1",
  nodeCount: flow.nodes.length,
  edgeCount: flow.edges.length,
  isHead: false,
  flow,
  layout,
};
const history: MediaFlowHistory = {
  schemaVersion: 1,
  flowId: flow.id,
  head: {
    schemaVersion: 1,
    flowId: flow.id,
    name: flow.name,
    description: flow.description,
    headRevisionId: "mfr-test-2",
    headRevisionNumber: 2,
    createdAt: flow.createdAt,
    updatedAt: "2026-07-14T09:00:00.000Z",
    documentDigest: "sha256:document-2",
    executionDigest: "sha256:execution-2",
    layoutDigest: "sha256:layout-2",
  },
  revisions: [
    {
      ...revision,
      revisionId: "mfr-test-2",
      revisionNumber: 2,
      parentRevisionId: revision.revisionId,
      createdAt: "2026-07-14T09:00:00.000Z",
      changeSummary: "Updated prompt",
      isHead: true,
    },
    revision,
  ],
};

describe("MediaFlowView revision UX", () => {
  it("requires an exact upload and billing review before a remote edit", () => {
    const editFlow = createImageEditFlow({
      id: "flow:remote-confirmation",
      createdAt: "2026-07-14T08:00:00.000Z",
      sourceAssetId: "asset:base",
      referenceAssets: [
        { assetId: "asset:style", role: "style", influence: 0.45 },
      ],
      settings: {
        prompt: "Preserve the subject and apply the style reference.",
        providerPolicy: "remote",
        modelPolicy: "quality",
        modelId: "openai:gpt-image-2",
        aspectRatio: "1:1",
        outputCount: 2,
        outputFormat: "png",
        transparentBackground: false,
        qualityGateEnabled: false,
        referenceImages: [],
        modelAddons: [],
      },
    });
    const onRunRemoteEdit = vi.fn();
    render(
      <MediaFlowView
        flow={editFlow}
        layout={createMediaFlowLayout(editFlow)}
        plan={compileMediaFlow({
          flow: editFlow,
          models,
          compiledAt: "2026-07-14T08:01:00.000Z",
        })}
        models={models}
        assets={[
          createAsset("asset:base", "a".repeat(64)),
          createAsset("asset:style", "b".repeat(64)),
        ]}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={null}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
        onRunRemoteEdit={onRunRemoteEdit}
        remoteRunSupported
        remoteRunDescription="Review and submit one paid request."
        remoteRunMode="native"
        remoteUploadManifest={[
          {
            assetId: "asset:base",
            digest: "a".repeat(64),
            byteSize: 1_024,
            role: "base",
            influence: 1,
          },
          {
            assetId: "asset:style",
            digest: "b".repeat(64),
            byteSize: 2_048,
            role: "style",
            influence: 0.45,
          },
        ]}
      />,
    );

    expect(onRunRemoteEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review remote run" }));
    expect(screen.getByRole("dialog", { name: "Confirm GPT Image 2 edit" })).toBeTruthy();
    expect(screen.getByText("2 images")).toBeTruthy();
    expect(screen.getByText("Provider calculated")).toBeTruthy();
    expect(screen.getByText("Base image")).toBeTruthy();
    expect(screen.getByText("style reference")).toBeTruthy();
    expect(screen.getByText(/no documented request lookup or idempotency key/u)).toBeTruthy();
    expect(onRunRemoteEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Upload 2 & run" }));
    expect(onRunRemoteEdit).toHaveBeenCalledTimes(1);
  });

  it("discloses every remote source asset in an image-edit preflight", () => {
    const editFlow = createImageEditFlow({
      id: "flow:edit-disclosure",
      createdAt: "2026-07-14T08:00:00.000Z",
      sourceAssetId: "asset:approved-source",
      settings: {
        prompt: "Replace only the background with warm travertine.",
        providerPolicy: "remote",
        modelPolicy: "quality",
        modelId: null,
        aspectRatio: "1:1",
        outputCount: 2,
        outputFormat: "png",
        transparentBackground: false,
        qualityGateEnabled: false,
        referenceImages: [],
        modelAddons: [],
      },
    });
    render(
      <MediaFlowView
        flow={editFlow}
        layout={createMediaFlowLayout(editFlow)}
        plan={compileMediaFlow({
          flow: editFlow,
          models,
          compiledAt: "2026-07-14T08:01:00.000Z",
        })}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={null}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Runtime plan · 5" }));
    expect(screen.getByText("Exact remote upload manifest")).toBeTruthy();
    expect(screen.getAllByText("asset:approved-source").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 disclosed source asset are sent/u)).toBeTruthy();
  });

  it("shows labeled edit references as an explicit multi-connection collection", () => {
    const editFlow = createImageEditFlow({
      id: "flow:multi-reference-inspector",
      createdAt: "2026-07-14T08:00:00.000Z",
      sourceAssetId: "asset:base",
      referenceAssets: [
        { assetId: "asset:style", role: "style", influence: 0.45 },
      ],
      settings: {
        prompt: "Preserve the subject and apply the style reference.",
        providerPolicy: "remote",
        modelPolicy: "quality",
        modelId: null,
        aspectRatio: "1:1",
        outputCount: 2,
        outputFormat: "png",
        transparentBackground: false,
        qualityGateEnabled: false,
        referenceImages: [],
        modelAddons: [],
      },
    });
    const onDisconnectConnection = vi.fn();
    const onNodeConfigChange = vi.fn();
    const sourceAssets = [
      createAsset("asset:base", "a".repeat(64)),
      createAsset("asset:style", "b".repeat(64)),
    ];
    const previewReadSpy = vi
      .spyOn(mediaRuntime, "readMediaAssetPreview")
      .mockResolvedValue(new Blob(["preview"]));
    const renderView = (assets: readonly MediaAssetRecord[]) => (
      <MediaFlowView
        flow={editFlow}
        layout={createMediaFlowLayout(editFlow)}
        plan={compileMediaFlow({
          flow: editFlow,
          models,
          compiledAt: "2026-07-14T08:01:00.000Z",
        })}
        models={models}
        assets={assets}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={onNodeConfigChange}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        onDisconnectConnection={onDisconnectConnection}
        history={null}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />
    );
    const { rerender } = render(renderView(sourceAssets));

    fireEvent.click(screen.getByRole("button", { name: "Select Source image" }));
    const assetPicker = screen.getByRole("button", { name: "Choose Source asset" });
    expect(previewReadSpy).toHaveBeenCalledTimes(1);
    rerender(renderView(sourceAssets.map((asset) => ({
      ...asset,
      tags: [...asset.tags],
    }))));
    expect(previewReadSpy).toHaveBeenCalledTimes(1);
    previewReadSpy.mockRestore();
    expect(screen.getByText("Image 1")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Source asset" })).toBeNull();
    expect(screen.queryByText(/sha256:a{64}/u)).toBeNull();
    expect(screen.queryByText("source.image · source-image")).toBeNull();
    expect(screen.queryByText("No input ports.")).toBeNull();
    expect(screen.queryByText(/Inspector changes update/u)).toBeNull();
    fireEvent.click(assetPicker);
    expect(screen.getByRole("dialog", { name: "Choose Source asset" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", {
      name: "Select Image 2, 1024 by 1024",
    }));
    expect(onNodeConfigChange).toHaveBeenCalledWith(
      "source-image",
      "assetId",
      "asset:style",
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Edit image" }));
    expect(screen.getByRole("group", { name: "Connect References" })).toBeTruthy();
    expect(screen.queryByText("2 connected")).toBeNull();
    const styleReference = screen.getByRole("checkbox", {
      name: "Use Style reference as References",
    });
    expect((styleReference as HTMLInputElement).checked).toBe(true);
    fireEvent.click(styleReference);
    expect(onDisconnectConnection).toHaveBeenCalledWith({
      fromNodeId: "reference-image-1",
      fromPortId: "image",
      toNodeId: "edit",
      toPortId: "image",
    });

    fireEvent.click(screen.getByRole("button", { name: "Runtime plan · 6" }));
    expect(screen.getAllByText("asset:base").length).toBeGreaterThan(0);
    expect(screen.getAllByText("asset:style").length).toBeGreaterThan(0);
  });

  it("discovers and safely forks a variable-driven built-in template", () => {
    const onTemplateApply = vi.fn();
    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onTemplateApply={onTemplateApply}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse flow templates · 3 built-in" }));
    expect(screen.getByRole("complementary", { name: "Flow templates" })).toBeTruthy();
    expect(screen.getByText("Text to image variants")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search flow templates" }), {
      target: { value: "cutout" },
    });
    expect(screen.getByText("Product cutout with quality gate")).toBeTruthy();
    expect(screen.queryByText("Text to image variants")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fork editable flow" }));
    expect(screen.getByRole("alert").textContent).toContain("new persisted flow identity");
    fireEvent.click(screen.getByRole("button", { name: "Confirm fork" }));

    expect(onTemplateApply).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "product-cutout-quality",
      flow: expect.objectContaining({
        name: "Product cutout with quality gate",
        variables: expect.arrayContaining([expect.objectContaining({ id: "variant-count" })]),
        nodes: expect.arrayContaining([
          expect.objectContaining({ type: "control.quality-gate" }),
          expect.objectContaining({
            type: "control.human-review",
            config: expect.objectContaining({ maxSelections: 2 }),
          }),
        ]),
      }),
      layout: expect.objectContaining({ schemaVersion: 1 }),
    }));
    const result = onTemplateApply.mock.calls[0]?.[0];
    expect(result.layout.flowId).toBe(result.flow.id);
  });

  it("edits the bounded human-review contract through the generated inspector", () => {
    const reviewTemplate = instantiateMediaFlowTemplate({
      templateId: "quality-gated-campaign",
      flowId: "flow:review-inspector",
      createdAt: "2026-07-14T08:02:00.000Z",
    });
    const onNodeConfigChange = vi.fn();
    render(
      <MediaFlowView
        flow={reviewTemplate.flow}
        layout={reviewTemplate.layout}
        plan={compileMediaFlow({
          flow: reviewTemplate.flow,
          models,
          compiledAt: "2026-07-14T08:03:00.000Z",
        })}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={onNodeConfigChange}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Human review" }));
    expect(screen.getByRole("complementary", { name: "Node inspector" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Review instructions" })).toBeTruthy();
    const maximumApprovals = screen.getByRole("spinbutton", {
      name: "Maximum approvals",
    });
    expect(maximumApprovals.getAttribute("max")).toBe("8");
    fireEvent.change(maximumApprovals, { target: { value: "2" } });
    expect(onNodeConfigChange).toHaveBeenCalledWith(
      "human-review",
      "maxSelections",
      2,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Expert" }));
    expect(
      screen.getByRole("switch", { name: "Require review note" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByText(/leases/i)).toBeNull();
  });

  it("authors typed variables, inserts tokens, and captures resolved binding presets", () => {
    const onFlowVariablesChange = vi.fn();
    const onNodeConfigChange = vi.fn();
    const subject = (currentFlow: MediaFlow) => (
      <MediaFlowView
        flow={currentFlow}
        layout={createMediaFlowLayout(currentFlow)}
        plan={compileMediaFlow({ flow: currentFlow, models, compiledAt: "2026-07-14T08:01:00.000Z" })}
        models={models}
        onLayoutChange={vi.fn()}
        onFlowVariablesChange={onFlowVariablesChange}
        onNodeConfigChange={onNodeConfigChange}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />
    );
    const { rerender } = render(subject(flow));

    fireEvent.click(screen.getByRole("button", { name: "Manage variables and presets · 0 variables · 0 presets" }));
    expect(screen.getByRole("complementary", { name: "Variables and presets" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add text variable" }));
    const variableFlow = onFlowVariablesChange.mock.calls.at(-1)?.[0] as MediaFlow;
    expect(variableFlow.variables[0]).toEqual(expect.objectContaining({ id: "variable-1", type: "text" }));

    rerender(subject(variableFlow));
    const currentValue = screen.getByRole("textbox", { name: "Current value for Text variable 1" });
    fireEvent.change(currentValue, { target: { value: "cinematic" } });
    fireEvent.blur(currentValue);
    const boundFlow = onFlowVariablesChange.mock.calls.at(-1)?.[0] as MediaFlow;
    expect(boundFlow.variableBindings).toEqual({ "variable-1": "cinematic" });

    rerender(subject(boundFlow));
    fireEvent.click(screen.getByRole("button", { name: "Insert in brief" }));
    const tokenFlow = onFlowVariablesChange.mock.calls.at(-1)?.[0] as MediaFlow;
    expect(tokenFlow.nodes.find((node) => node.id === "prompt")?.config.prompt).toContain("{{variable-1}}");

    rerender(subject(tokenFlow));
    fireEvent.change(screen.getByRole("textbox", { name: "New preset name" }), { target: { value: "Cinematic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const presetFlow = onFlowVariablesChange.mock.calls.at(-1)?.[0] as MediaFlow;
    expect(presetFlow.presets[0]).toEqual(expect.objectContaining({
      name: "Cinematic",
      values: { "variable-1": "cinematic" },
    }));
    expect(presetFlow.activePresetId).toBe("preset-1");

    rerender(subject(presetFlow));
    fireEvent.click(screen.getByRole("button", { name: "Add number variable" }));
    const numericFlow = onFlowVariablesChange.mock.calls.at(-1)?.[0] as MediaFlow;
    rerender(subject(numericFlow));
    fireEvent.click(screen.getByRole("button", { name: "Select Generate image" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Variable binding for Variants" }), {
      target: { value: "variable-2" },
    });
    expect(onNodeConfigChange).toHaveBeenCalledWith("generate", "outputCount", "{{variable-2}}");

    const boundNumericFlow: MediaFlow = {
      ...numericFlow,
      nodes: numericFlow.nodes.map((node) => node.id === "generate"
        ? { ...node, config: { ...node.config, outputCount: "{{variable-2}}" } }
        : node),
    };
    rerender(subject(boundNumericFlow));
    expect(screen.getByText("{{variable-2}}")).toBeTruthy();
    expect(screen.queryByText("Variants does not satisfy the node's versioned constraints.")).toBeNull();
  });

  it("exposes unsaved state and restores an older revision through an append-only action", () => {
    const onSaveRevision = vi.fn();
    const onRestoreRevision = vi.fn();

    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice="Saved immutable revision 2."
        hasUnsavedChanges
        onRefreshHistory={vi.fn()}
        onSaveRevision={onSaveRevision}
        onRestoreRevision={onRestoreRevision}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Saved immutable revision 2.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    expect(onSaveRevision).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "History · 2" }));
    expect(screen.getByRole("complementary", { name: "Flow revision history" })).toBeTruthy();
    expect(screen.getByText("Revision 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(
      screen.getByRole("region", { name: "Revision comparison" }).textContent,
    ).toContain("Revision 1 → 2");
    expect(screen.getByText("Execution")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestoreRevision).toHaveBeenCalledWith(revision);
  });

  it("keeps unsupported imported nodes inspectable and blocks the import action", () => {
    const inspection: MediaFlowImportInspection = {
      schemaVersion: 1,
      status: "inspect-only",
      canImport: false,
      reviewToken: "mfir-review",
      sourceDisplayName: "future-flow.machdoch-flow.json",
      bundleDigest: "sha256:future",
      bundleSchemaVersion: 1,
      sourceFlowId: "flow:future",
      sourceFlowName: "Future image flow",
      sourceRevisionId: "mfr-future",
      proposedFlowId: null,
      nodeCount: 3,
      edgeCount: 2,
      documentDigest: "sha256:document",
      executionDigest: "sha256:execution",
      layoutDigest: "sha256:layout",
      requirements: [
        { nodeType: "task.generate-image", version: 2, supported: false },
      ],
      issues: [
        {
          severity: "warning",
          code: "UNKNOWN_NODE_VERSION",
          message: "A newer node version is preserved for inspection.",
          nodeId: "generate",
        },
      ],
      unknownNodes: [
        {
          schemaVersion: 1,
          nodeId: "generate",
          nodeType: "task.generate-image",
          version: 2,
          originalNode: { id: "generate", version: 2 },
          connectedEdges: [{ id: "prompt-generate" }],
        },
      ],
      importMutations: [],
    };
    const onImportReviewed = vi.fn();

    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={inspection}
        onInspectImport={vi.fn()}
        onImportReviewed={onImportReviewed}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(
      screen.getByRole("complementary", { name: "Flow portability review" }),
    ).toBeTruthy();
    expect(screen.getByText("Read-only inspection")).toBeTruthy();
    expect(screen.getByText("Preserved unknown nodes")).toBeTruthy();
    const importButton = screen.getByRole("button", {
      name: "Import isolated copy",
    });
    expect(importButton).toHaveProperty("disabled", true);
    fireEvent.click(importButton);
    expect(onImportReviewed).not.toHaveBeenCalled();
  });

  it("edits semantic settings through progressive schema-generated controls", () => {
    const onNodeConfigChange = vi.fn();

    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={onNodeConfigChange}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Generate image" }));
    expect(screen.getByRole("complementary", { name: "Node inspector" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Basic" }).getAttribute("aria-selected"),
    ).toBe(
      "true",
    );

    fireEvent.change(screen.getByRole("spinbutton", { name: "Variants" }), {
      target: { value: "3" },
    });
    expect(onNodeConfigChange).toHaveBeenCalledWith(
      "generate",
      "outputCount",
      3,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Expert" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Exact model pin" }), {
      target: { value: "openai:gpt-image-2" },
    });
    expect(onNodeConfigChange).toHaveBeenCalledWith(
      "generate",
      "modelId",
      "openai:gpt-image-2",
    );
  });

  it("edits ordered subject-cutout model priority and fallback", () => {
    const onNodeConfigChange = vi.fn();
    const cutoutFlow = createSubjectCutoutFlow({
      id: "flow:cutout-policy",
      createdAt: "2026-07-14T08:00:00.000Z",
      sourceAssetId: "asset:source",
    });
    const cutoutModels = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalBiRefNetInstalled: true,
    });
    const cutoutPlan = compileMediaFlow({
      flow: cutoutFlow,
      models: cutoutModels,
      compiledAt: "2026-07-14T08:01:00.000Z",
    });
    render(
      <MediaFlowView
        flow={cutoutFlow}
        layout={createMediaFlowLayout(cutoutFlow)}
        plan={cutoutPlan}
        models={cutoutModels}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={onNodeConfigChange}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={null}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Cut out subject" }));
    expect(
      (screen.getByRole("combobox", {
        name: "Primary subject-cutout model",
      }) as HTMLSelectElement).value,
    ).toBe("local:birefnet-matting");
    expect(
      (screen.getByRole("combobox", {
        name: "Fallback 1 subject-cutout model",
      }) as HTMLSelectElement).value,
    ).toBe("local:border-matte-v1");

    fireEvent.click(
      screen.getByRole("button", { name: "Move Local Border Matte up" }),
    );
    expect(onNodeConfigChange).toHaveBeenCalledWith(
      "subject-cutout",
      "modelPriority",
      ["local:border-matte-v1", "local:birefnet-matting"],
    );
  });

  it("adds searchable nodes and exposes keyboard-accessible connection and removal controls", () => {
    const onNodeAdd = vi.fn().mockReturnValue("subject-cutout");
    const onNodeRemove = vi.fn();
    const onConnectPorts = vi.fn();
    const onDisconnectInput = vi.fn();
    const onUndoSemantic = vi.fn();
    const onRedoSemantic = vi.fn();
    const onNodeCopy = vi.fn();
    const onNodesCopy = vi.fn();
    const onNodePaste = vi.fn().mockReturnValue("quality-analyze-2");
    const onLayoutChange = vi.fn();

    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={onLayoutChange}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={onNodeAdd}
        onNodeRemove={onNodeRemove}
        onConnectPorts={onConnectPorts}
        onDisconnectInput={onDisconnectInput}
        canUndoSemantic
        canRedoSemantic
        onUndoSemantic={onUndoSemantic}
        onRedoSemantic={onRedoSemantic}
        onNodeCopy={onNodeCopy}
        onNodesCopy={onNodesCopy}
        onNodePaste={onNodePaste}
        clipboardLabel="Analyze quality"
        canPasteNode
        pasteBlockedReason={null}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo semantic change" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo semantic change" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste Analyze quality" }));
    expect(onUndoSemantic).toHaveBeenCalledTimes(1);
    expect(onRedoSemantic).toHaveBeenCalledTimes(1);
    expect(onNodePaste).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Manage node selection · 0" }));
    expect(screen.getByRole("complementary", { name: "Node selection" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Creative brief" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Save assets" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy 2 selected nodes" }));
    expect(onNodesCopy).toHaveBeenLastCalledWith(["prompt", "asset-output"]);
    fireEvent.click(screen.getByRole("button", { name: "Close node selection" }));

    fireEvent.click(screen.getByRole("button", { name: "Select all visible flow nodes" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy 3 selected nodes" }));
    expect(onNodesCopy).toHaveBeenCalledWith(["prompt", "generate", "asset-output"]);
    fireEvent.click(screen.getByRole("button", { name: "Group 3 selected nodes" }));
    expect(onLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [expect.objectContaining({ nodeIds: ["prompt", "generate", "asset-output"] })],
      }),
    );
    expect(
      screen.getByRole("complementary", { name: "Canvas organization" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(onLayoutChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            id: "comment-1",
            body: "Workflow note",
            color: "amber",
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Runtime plan/ }));
    expect(screen.getByRole("region", { name: "Flow validation" })).toBeTruthy();
    expect(screen.getByText("Errors")).toBeTruthy();
    expect(screen.getByText("Warnings")).toBeTruthy();
    expect(screen.getByText("Information")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Runtime plan/ }));

    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(screen.getByRole("complementary", { name: "Node palette" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search node palette" }), {
      target: { value: "subject" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Cut out subject" }));
    expect(onNodeAdd).toHaveBeenCalledWith("operation.subject-cutout");
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search node palette" }), {
      target: { value: "human review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Human review" }));
    expect(onNodeAdd).toHaveBeenCalledWith("control.human-review");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "Node palette" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close node palette" }));

    fireEvent.click(screen.getByRole("button", { name: "Select Generate image" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Generate image" }));
    expect(onNodeCopy).toHaveBeenCalledWith("generate");
    const promptConnection = screen.getByRole("combobox", { name: "Connect Prompt" });
    fireEvent.change(promptConnection, {
      target: { value: "prompt\u001fprompt" },
    });
    expect(onConnectPorts).toHaveBeenCalledWith({
      fromNodeId: "prompt",
      fromPortId: "prompt",
      toNodeId: "generate",
      toPortId: "prompt",
    });
    fireEvent.change(promptConnection, { target: { value: "" } });
    expect(onDisconnectInput).toHaveBeenCalledWith("generate", "prompt");

    fireEvent.click(screen.getByRole("button", { name: "Remove Generate image" }));
    expect(
      screen.getByRole("alertdialog", {
        name: "Confirm removal of Generate image",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove node" }));
    expect(onNodeRemove).toHaveBeenCalledWith("generate");
  });

  it("renders and dismisses immutable run evidence over the editable graph", () => {
    const onRunOverlayClear = vi.fn();
    const finalAsset = {
      ...createAsset("asset:flow-overlay:0", "c".repeat(64)),
      runId: "run:flow-overlay",
    };
    const runOverlay: MediaRunDetail = {
      id: "run:flow-overlay",
      flowId: flow.id,
      flowRevisionId: "revision:flow-overlay",
      flowName: flow.name,
      planId: plan.id,
      status: "completed",
      createdAt: "2026-07-14T08:01:00.000Z",
      prompt: "A revision history interface",
      modelLabel: plan.preflight.modelLabel,
      target: plan.preflight.target,
      outputCount: 1,
      diagnosticCount: plan.diagnostics.length,
      updatedAt: "2026-07-14T08:02:00.000Z",
      progress: 1,
      currentStep: "Completed",
      executor: "deterministic-fixture",
      error: null,
      failure: null,
      events: [
        {
          id: 1,
          runId: "run:flow-overlay",
          sequence: 1,
          kind: "run_completed",
          createdAt: "2026-07-14T08:02:00.000Z",
          message: "Run completed.",
          progress: 1,
          stepId: null,
          nodeId: null,
        },
      ],
      assets: [finalAsset],
      providerJobs: [],
      humanReviews: [],
      nodeExecutions: [],
      planSnapshot: {
        schemaVersion: 1,
        planId: plan.id,
        flowId: flow.id,
        flowFingerprint: plan.flowFingerprint,
        compiledAt: plan.compiledAt,
        nodes: flow.nodes.map(({ id, type, label, layer }) => ({
          id,
          type,
          label,
          layer,
        })),
        steps: plan.steps,
      },
    };

    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
        runOverlay={runOverlay}
        onRunOverlayClear={onRunOverlayClear}
      />,
    );

    expect(screen.getByRole("region", { name: "Run overlay" })).toBeTruthy();
    expect(screen.getByText(`Run overlay · ${flow.name}`)).toBeTruthy();
    expect(screen.getByText(/completed · 3/i)).toBeTruthy();
    const outputNode = screen.getByRole("button", { name: "Select Save assets" });
    expect(outputNode.getAttribute("data-asset-id")).toBe(finalAsset.id);
    expect(outputNode.getAttribute("data-asset-label")).toBe("Final image");
    fireEvent.click(screen.getByRole("button", { name: "Close overlay" }));
    expect(onRunOverlayClear).toHaveBeenCalledTimes(1);
  });

  it("runs an eligible pinned local utility flow from the canvas toolbar", () => {
    const onRunLocalFlow = vi.fn();
    render(
      <MediaFlowView
        flow={flow}
        layout={layout}
        plan={plan}
        models={models}
        onLayoutChange={vi.fn()}
        onNodeConfigChange={vi.fn()}
        onNodeAdd={vi.fn()}
        onNodeRemove={vi.fn()}
        onConnectPorts={vi.fn()}
        onDisconnectInput={vi.fn()}
        history={history}
        revisionLoading={false}
        revisionNotice={null}
        hasUnsavedChanges={false}
        onRefreshHistory={vi.fn()}
        onSaveRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        portabilitySupported
        portabilityLoading={false}
        importInspection={null}
        onInspectImport={vi.fn()}
        onImportReviewed={vi.fn()}
        onDismissImport={vi.fn()}
        onExportRevision={vi.fn()}
        onRunLocalFlow={onRunLocalFlow}
        localRunSupported
        localRunDescription="Runs without a network request."
      />,
    );

    const runButton = screen.getByRole("button", { name: "Run local" });
    expect(runButton.getAttribute("title")).toBe(
      "Runs without a network request.",
    );
    fireEvent.click(runButton);
    expect(onRunLocalFlow).toHaveBeenCalledTimes(1);
  });
});
