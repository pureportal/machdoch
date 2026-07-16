import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { readMediaAssetReferencePreview } from "../media-runtime";
import { MediaLibraryView } from "./media-library-view";

vi.mock("../media-runtime", () => ({
  readMediaAssetReferencePreview: vi.fn(() => Promise.resolve(new Blob(["preview"]))),
}));

const asset: MediaAssetRecord = {
  id: "asset:stable-source",
  runId: "run:stable-source",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1_024,
  width: 384,
  height: 384,
  createdAt: "2026-07-14T12:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};

const createProps = (
  overrides: Partial<ComponentProps<typeof MediaLibraryView>> = {},
): ComponentProps<typeof MediaLibraryView> => ({
  assets: [asset],
  runtimeStatus: {
    schemaVersion: 17,
    recoveredRuns: 0,
    queuedRuns: 0,
    activeRuns: 0,
    storageReady: true,
    mode: "browser-preview",
    directGenerationModelIds: ["openai:gpt-image-2"],
    directReferenceImageModelIds: ["openai:gpt-image-2"],
    localDiffusers: {
      status: "unavailable",
      ready: false,
      workerVersion: null,
      pythonVersion: null,
      packages: {},
      device: null,
      deviceLabel: null,
      deviceMemoryBytes: null,
      architectures: [],
      capabilities: [],
      diagnostic: "Not installed",
    },
  },
  runtimeError: null,
  importSupported: false,
  importLoading: false,
  transformLoading: false,
  exportSupported: false,
  exportLoading: false,
  exportNotice: null,
  deletionNotice: null,
  qualityLoadingAssetId: null,
  qualityReports: {},
  tagLoadingAssetId: null,
  chatWorkspaceAvailable: true,
  onImport: vi.fn(),
  onTransform: vi.fn(),
  onExport: vi.fn(),
  onAnalyzeQuality: vi.fn(),
  onLoadQualityReport: vi.fn(),
  onUpdateTags: vi.fn(),
  onAutoTag: vi.fn(),
  onSendToChat: vi.fn(),
  onOpenAsFlow: vi.fn(),
  onOpenBackgroundRemovalAsFlow: vi.fn(),
  onOpenAlphaMatteAsFlow: vi.fn(),
  onOpenCompositeAsFlow: vi.fn(),
  onOpenContactSheetAsFlow: vi.fn(),
  onOpenTransformAsFlow: vi.fn(),
  onPlanDeletion: vi.fn(async () => {
    throw new Error("not used");
  }),
  onDeleteAsset: vi.fn(async () => {
    throw new Error("not used");
  }),
  ...overrides,
});

const openFollowUpActions = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Follow Up" }));
  expect(
    screen.getByRole("dialog", { name: "Follow Up actions" }),
  ).toBeTruthy();
};

describe("MediaLibraryView asset cards", () => {
  it("shows concise image metadata without badges or hashes", () => {
    render(<MediaLibraryView {...createProps()} />);

    expect(screen.getByText("Dimensions")).toBeTruthy();
    expect(screen.getByText("384 × 384")).toBeTruthy();
    expect(screen.getByText("Size")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("Aspect ratio")).toBeTruthy();
    expect(screen.getByText("1:1")).toBeTruthy();
    expect(screen.queryByText("Encoded")).toBeNull();
    expect(screen.queryByText(/sha256:/u)).toBeNull();
    expect(document.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("opens a larger contained preview from the card thumbnail", async () => {
    const previewReadMock = vi.mocked(readMediaAssetReferencePreview);
    previewReadMock.mockClear();
    render(<MediaLibraryView {...createProps()} />);
    await waitFor(() => expect(previewReadMock).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Preview Output 1, item 1" }),
    );

    expect(screen.getByRole("dialog", { name: "Preview Output 1" })).toBeTruthy();
    await waitFor(() => expect(previewReadMock).toHaveBeenCalledTimes(2));
    expect(previewReadMock).toHaveBeenLastCalledWith(asset.id, 2_048);
  });

  it("opens asset actions on right click and dispatches the selected action", async () => {
    const onSendToChat = vi.fn();
    render(<MediaLibraryView {...createProps({ onSendToChat })} />);

    const previewButton = screen.getByRole("button", {
      name: "Preview Output 1, item 1",
    });
    expect(
      previewButton.closest("[data-app-context-menu-trigger]"),
    ).toBeTruthy();

    fireEvent.contextMenu(previewButton);

    expect(
      await screen.findByRole("menu", { name: "Actions for Output 1" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Inspect details" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Open text-guided edit as Flow" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Review deletion impact" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Send to Chat" }));
    expect(onSendToChat).toHaveBeenCalledWith(asset);
  });
});

describe("MediaLibraryView transform inspector", () => {
  it("opens the selected asset as a local background-removal flow", () => {
    const onOpenBackgroundRemovalAsFlow = vi.fn();
    render(
      <MediaLibraryView
        {...createProps({ onOpenBackgroundRemovalAsFlow })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select imported asset Output 1, item 1" }),
    );
    expect(
      screen.queryByText(/Non-destructive operations publish/u),
    ).toBeNull();
    expect(screen.queryByText("Metadata only")).toBeNull();
    openFollowUpActions();
    fireEvent.click(
      screen.getByRole("button", { name: "Cut out subject as Flow" }),
    );
    expect(onOpenBackgroundRemovalAsFlow).toHaveBeenCalledWith(asset);
  });

  it("opens the selected asset as an exact alpha-matte flow", () => {
    const onOpenAlphaMatteAsFlow = vi.fn();
    render(<MediaLibraryView {...createProps({ onOpenAlphaMatteAsFlow })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Select imported asset Output 1, item 1" }),
    );
    openFollowUpActions();
    fireEvent.click(
      screen.getByRole("button", { name: "Extract alpha matte as Flow" }),
    );
    expect(onOpenAlphaMatteAsFlow).toHaveBeenCalledWith(asset);
  });

  it("selects an ordered background and opens an editable composite flow", () => {
    const onOpenCompositeAsFlow = vi.fn();
    const background: MediaAssetRecord = {
      ...asset,
      id: "asset:background",
      runId: "run:background",
      digest: "b".repeat(64),
      width: 1_024,
      height: 768,
    };
    render(
      <MediaLibraryView
        {...createProps({ assets: [asset, background], onOpenCompositeAsFlow })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Select imported asset Output 1, item 1" }),
    );
    openFollowUpActions();
    fireEvent.click(
      screen.getByRole("button", { name: "Composite over background as Flow" }),
    );
    expect(screen.getByRole("dialog", { name: "Choose composite background" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Use Output 1 bbbbbbbbbbbb as composite background/u,
      }),
    );

    expect(onOpenCompositeAsFlow).toHaveBeenCalledWith(asset, background);
  });

  it("selects two to eight images in explicit order for a contact-sheet flow", async () => {
    const onOpenContactSheetAsFlow = vi.fn();
    const previewReadMock = vi.mocked(readMediaAssetReferencePreview);
    previewReadMock.mockClear();
    const second: MediaAssetRecord = {
      ...asset,
      id: "asset:second",
      runId: "run:second",
      digest: "b".repeat(64),
      outputIndex: 1,
      width: 640,
      height: 360,
    };
    render(
      <MediaLibraryView
        {...createProps({ assets: [asset, second], onOpenContactSheetAsFlow })}
      />,
    );
    await waitFor(() => expect(previewReadMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Build contact sheet" }));
    expect(screen.getByRole("dialog", { name: "Build contact sheet" })).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Open 0 images as Flow",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Output 2 bbbbbbbbbbbb for contact sheet/u,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Output 1 aaaaaaaaaaaa for contact sheet/u,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open 2 images as Flow" }));

    expect(onOpenContactSheetAsFlow).toHaveBeenCalledWith([second, asset]);
  });

  it("preserves an in-progress transform and thumbnail when the same asset metadata refreshes", async () => {
    const onOpenTransformAsFlow = vi.fn();
    const previewReadMock = vi.mocked(readMediaAssetReferencePreview);
    previewReadMock.mockClear();
    const props = createProps({ onOpenTransformAsFlow });
    const { rerender } = render(<MediaLibraryView {...props} />);
    await waitFor(() => expect(previewReadMock).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Select imported asset Output 1, item 1" }),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), {
      target: { value: "320" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Height" }), {
      target: { value: "180" },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Resize fit mode" }),
      { target: { value: "cover" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Transform output format" }),
      { target: { value: "jpeg" } },
    );

    rerender(
      <MediaLibraryView
        {...props}
        assets={[{ ...asset, tags: [...asset.tags] }]}
      />,
    );
    expect(previewReadMock).toHaveBeenCalledTimes(1);

    expect((screen.getByRole("spinbutton", { name: "Width" }) as HTMLInputElement).value).toBe(
      "320",
    );
    expect((screen.getByRole("spinbutton", { name: "Height" }) as HTMLInputElement).value).toBe(
      "180",
    );
    expect(
      (screen.getByRole("combobox", { name: "Resize fit mode" }) as HTMLSelectElement)
        .value,
    ).toBe("cover");
    expect(
      (screen.getByRole("combobox", {
        name: "Transform output format",
      }) as HTMLSelectElement).value,
    ).toBe("jpeg");
    openFollowUpActions();
    fireEvent.click(
      screen.getByRole("button", { name: "Open current transform as Flow" }),
    );
    expect(onOpenTransformAsFlow).toHaveBeenCalledWith({
      sourceAssetId: asset.id,
      operation: {
        kind: "resize",
        width: 320,
        height: 180,
        fit: "cover",
      },
      outputFormat: "jpeg",
      quality: 90,
      jpegBackground: "#ffffff",
    });
  });

  it("shows ordered edit lineage and opens an immutable source", async () => {
    const derived: MediaAssetRecord = {
      ...asset,
      id: "asset:edited-output",
      runId: "run:edited-output",
      digest: "b".repeat(64),
      operation: {
        kind: "remote-image-edit",
        providerId: "openai",
        modelId: "openai:gpt-image-2",
        modelSnapshot: "gpt-image-2-2026-04-21",
        providerRequestId: "req_edit_1",
        flowRevisionId: "revision:edit",
        taskNodeId: "edit",
        editStrength: 0.7,
        metadataStrippedBeforeUpload: true,
        orientationAppliedBeforeUpload: true,
        colorProfilePreservedBeforeUpload: true,
        sources: [
          {
            order: 1,
            nodeId: "base",
            assetId: asset.id,
            role: "base",
            influence: 1,
            sourceDigest: asset.digest,
            uploadDigest: "c".repeat(64),
            uploadBytes: 768,
            width: asset.width,
            height: asset.height,
          },
        ],
      },
      sourceAssetIds: [asset.id],
    };

    render(<MediaLibraryView {...createProps({ assets: [derived, asset] })} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select edited asset remote-image-edit output, item 1",
      }),
    );

    expect(screen.getByRole("region", { name: "Source lineage" })).toBeTruthy();
    expect(screen.getByText("base · 100% influence")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: `Open source ${asset.id}` }),
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Select imported asset Output 1, item 2" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });

  it("keeps exact matte derivation lossless and hides nonsensical actions", () => {
    const matte: MediaAssetRecord = {
      ...asset,
      id: "asset:alpha-matte",
      runId: "run:alpha-matte",
      digest: "d".repeat(64),
      operation: {
        kind: "local-image-flow",
        flowRevisionId: "revision:alpha",
        metadataStripped: true,
        assetRole: "alpha-matte",
        alphaExtraction: null,
      },
      sourceAssetIds: [asset.id],
      tags: [
        {
          value: "alpha-matte",
          label: "Alpha matte",
          source: "technical",
          confidence: 1,
          createdAt: asset.createdAt,
        },
      ],
    };

    render(<MediaLibraryView {...createProps({ assets: [matte, asset] })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Select derived asset Alpha matte, item 1" }),
    );

    expect(screen.queryByRole("option", { name: /JPEG/u })).toBeNull();
    openFollowUpActions();
    expect(
      screen.queryByRole("button", { name: "Open text-guided edit as Flow" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove studio background as Flow" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Extract alpha matte as Flow" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Composite over background as Flow" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Create preview derivative" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open current transform as Flow" })).toBeTruthy();
    expect(screen.queryByText(/Exact matte asset/u)).toBeNull();
  });
});
