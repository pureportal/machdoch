// @vitest-environment jsdom

import { createElement, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MediaRefModSelection } from "../../../../core/media/contracts.js";
import { MediaRefModControls } from "./media-refmod-controls";
import { MediaRefModPreview } from "./media-refmod-preview";
import { MediaRefModCreator } from "./media-refmod-creator";
import { MediaRefModLibraryAction } from "./media-refmod-library-action";
import { open, releaseFile, save } from "../media-platform";
import { refModOperation, type RefModInspection } from "../media-refmods";

vi.mock("../media-platform", () => ({
  open: vi.fn(),
  save: vi.fn(),
  releaseFile: vi.fn(),
  pickedFileName: (path: string) => path.split(/[\\/]/u).at(-1)!,
  isRemoteMedia: () => false,
}));
vi.mock("../media-refmods", () => ({
  refModOperation: vi.fn(
    async (_root: string, request: { path?: string; paths?: string[] }) => {
      const inspect = (path: string) => ({
        path: path.replaceAll("/", "\\"),
        name: path.includes("voice") ? "Voice" : "Hero",
        members: [
          {
            key: "latent",
            name: "Subject",
            kind: path.includes("voice") ? "audio" : "image",
            tokens: 4,
            frameCount: path.includes("voice") ? 0 : 1,
            shape: path.includes("voice") ? [1, 32, 2, 2] : [1, 24, 1, 4, 4],
            metadata: {},
          },
        ],
      });
      return request.paths
        ? request.paths.map((path) => ({ path, record: inspect(path) }))
        : inspect(request.path!);
    },
  ),
}));
afterEach(cleanup);

it("releases the whole selected upload batch after an import fails", async () => {
  vi.mocked(releaseFile).mockClear();
  vi.mocked(open).mockResolvedValueOnce([
    "C:/uploads/invalid.safetensors",
    "C:/uploads/later.safetensors",
  ]);
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  vi.mocked(refModOperation).mockRejectedValueOnce(
    new Error("Invalid RefMod metadata"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Invalid RefMod metadata",
    ),
  );
  expect(releaseFile).toHaveBeenCalledTimes(2);
  expect(releaseFile).toHaveBeenCalledWith("C:/uploads/invalid.safetensors");
  expect(releaseFile).toHaveBeenCalledWith("C:/uploads/later.safetensors");
});

it("closes the creator through its named action and releases its selected source", async () => {
  vi.mocked(releaseFile).mockClear();
  vi.mocked(open).mockResolvedValueOnce(["C:/inputs/source.png"]);
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "Create RefMod" }));
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  await waitFor(() => expect(screen.getByText("source.png")).toBeTruthy());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Close creator" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close creator" }));
  await waitFor(() =>
    expect(releaseFile).toHaveBeenCalledExactlyOnceWith("C:/inputs/source.png"),
  );
  expect(screen.queryByRole("group", { name: "Create RefMod" })).toBeNull();
  expect(screen.getByRole("button", { name: "Create RefMod" })).toBeTruthy();
});

it("saves standalone audio creation in the workspace library", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/voice.wav");
  vi.mocked(save).mockResolvedValueOnce("C:/voice.safetensors");
  const reference: RefModInspection = {
    path: "C:/work/models/refmods/voice.safetensors",
    name: "Voice",
    kind: "bundle",
    tokens: 160,
    sizeBytes: 20480,
    members: [
      {
        key: "ref_0",
        kind: "audio",
        name: "Voice",
        tokens: 160,
        frameCount: 0,
        shape: [1, 32, 2, 80],
      },
    ],
  };
  const editor = render(
    createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "Create RefMod" }));
  fireEvent.click(screen.getByRole("button", { name: "Add audio" }));
  await waitFor(() => expect(screen.getByText("voice.wav")).toBeTruthy());
  vi.mocked(refModOperation).mockResolvedValueOnce(reference);
  fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
  await waitFor(() => expect(screen.getByText("Voice")).toBeTruthy());
  expect(screen.queryByRole("group", { name: "Create RefMod" })).toBeNull();
  expect(screen.getByRole("button", { name: "Export bundle" })).toBeTruthy();
  expect(screen.queryByLabelText("Visual strength")).toBeNull();
  expect(refModOperation).toHaveBeenCalledWith(
    "C:/work",
    expect.objectContaining({
      operation: "create",
      keepInLibrary: true,
      outputPath: "C:/voice.safetensors",
      sources: [{ path: "C:/voice.wav", kind: "audio", startSeconds: 0 }],
    }),
  );
  fireEvent.change(screen.getByLabelText("Audio strength"), {
    target: { value: "0.35" },
  });
  fireEvent.click(screen.getByText("Inspect reference"));
  fireEvent.click(screen.getByLabelText("Compare strength"));
  vi.mocked(refModOperation).mockResolvedValueOnce({
    kind: "audio",
    previews: [
      "data:audio/wav;base64,UklGRg==",
      "data:audio/wav;base64,UklGRgAAAAA=",
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() =>
    expect(editor.container.querySelectorAll("audio")).toHaveLength(2),
  );
  expect(refModOperation).toHaveBeenLastCalledWith(
    "C:/work",
    expect.objectContaining({
      operation: "preview",
      path: "C:\\work\\models\\refmods\\voice.safetensors",
      compare: true,
      strength: 0.35,
    }),
  );
});

it("keeps standalone creation editable after a missing VAE error", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/voice.wav");
  vi.mocked(save).mockResolvedValueOnce("C:/voice.safetensors");
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "Create RefMod" }));
  fireEvent.click(screen.getByRole("button", { name: "Add audio" }));
  await waitFor(() => expect(screen.getByText("voice.wav")).toBeTruthy());
  vi.mocked(refModOperation).mockRejectedValueOnce(
    new Error("Install the MiniMax H3 audio VAE"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Install the MiniMax H3 audio VAE",
    ),
  );
  expect(screen.getByText("voice.wav")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Create and save",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Close RefMods",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

it("imports and exports references before generation and keeps the selection when reopened", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/hero.safetensors");
  vi.mocked(save).mockResolvedValueOnce("C:/references.safetensors");
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await waitFor(() => expect(screen.getByText("Hero")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Copies"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Visual strength"), {
    target: { value: "0.5" },
  });
  fireEvent.click(screen.getByText("Curves"));
  fireEvent.change(screen.getByLabelText("Reference frames"), {
    target: { value: "ends" },
  });
  expect(screen.queryByLabelText("Denoising steps")).toBeNull();
  expect(screen.queryByRole("button", { name: "<Picture 1>" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Export bundle" }));
  await waitFor(() =>
    expect(refModOperation).toHaveBeenCalledWith("C:/work", {
      operation: "save",
      outputPath: "C:/references.safetensors",
      name: "References",
      maxTokens: 65536,
      slots: [
        expect.objectContaining({
          path: "C:\\hero.safetensors",
          enabled: true,
          copies: 2,
          visualStrength: 0.5,
          frameCurve: "ends",
        }),
      ],
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Close RefMods",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  await waitFor(() => expect(screen.getByText("Hero")).toBeTruthy());
  expect((screen.getByLabelText("Copies") as HTMLInputElement).value).toBe("2");
  expect(
    (screen.getByLabelText("Visual strength") as HTMLInputElement).value,
  ).toBe("0.5");
});

it("keeps standalone preview cancellation usable while closing is disabled", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/hero.safetensors");
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await waitFor(() => expect(screen.getByText("Hero")).toBeTruthy());
  fireEvent.click(screen.getByText("Inspect reference"));
  let reject!: (failure: Error) => void;
  let operationId = "";
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    operationId = String(request.operationId);
    return new Promise((_resolve, failure) => {
      reject = failure;
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(
    (screen.getByRole("button", { name: "Close RefMods" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toEqual({ operation: "cancel", operationId });
    reject(new Error("Local operation was canceled"));
    return { canceled: true };
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Close RefMods",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.getByText("Hero")).toBeTruthy();
});

it("opens the workspace library without a directory picker and resets a previous search", async () => {
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  vi.mocked(refModOperation).mockResolvedValueOnce({
    records: [
      {
        path: "C:/work/models/refmods/hero.safetensors",
        name: "Hero",
        tokens: 4,
      },
    ],
    errors: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() => expect(screen.getByText("Hero · 4 tokens")).toBeTruthy());
  expect(refModOperation).toHaveBeenLastCalledWith("C:/work", {
    operation: "list",
  });
  fireEvent.change(screen.getByLabelText("Search RefMods"), {
    target: { value: "missing" },
  });
  expect(screen.queryByText("Hero · 4 tokens")).toBeNull();
  vi.mocked(refModOperation).mockResolvedValueOnce({
    records: [
      {
        path: "C:/work/models/refmods/voice.safetensors",
        name: "Voice",
        tokens: 160,
      },
    ],
    errors: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() =>
    expect(screen.getByText("Voice · 160 tokens")).toBeTruthy(),
  );
  expect(
    (screen.getByLabelText("Search RefMods") as HTMLInputElement).value,
  ).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Export bundle" })).toBeTruthy(),
  );
});

it("keeps the workspace library usable when empty", async () => {
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  vi.mocked(refModOperation).mockResolvedValueOnce({ records: [], errors: [] });
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Search RefMods")).toBeTruthy(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(screen.getByRole("button", { name: "Create RefMod" })).toBeTruthy();
});

it("clears previous library results after a failed refresh and allows a retry", async () => {
  render(createElement(MediaRefModLibraryAction, { workspaceRoot: "C:/work" }));
  fireEvent.click(screen.getByRole("button", { name: "RefMods" }));
  vi.mocked(refModOperation).mockResolvedValueOnce({
    records: [{ path: "C:/old/hero.safetensors", name: "Hero", tokens: 4 }],
    errors: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() => expect(screen.getByText("Hero · 4 tokens")).toBeTruthy());
  vi.mocked(refModOperation).mockRejectedValueOnce(
    new Error("Could not open the RefMod library"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not open the RefMod library",
    ),
  );
  expect(screen.queryByText("Hero · 4 tokens")).toBeNull();
  expect(screen.queryByLabelText("Search RefMods")).toBeNull();
  vi.mocked(refModOperation).mockResolvedValueOnce({ records: [], errors: [] });
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Search RefMods")).toBeTruthy(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps preview cancellation enabled while the editor controls are disabled", async () => {
  render(
    createElement(MediaRefModControls, {
      workspaceRoot: "C:/workspace",
      settings: {
        refMods: [
          {
            path: "C:/hero.safetensors",
            enabled: true,
            selection: "all",
            visualStrength: 1,
            audioStrength: 1,
            copies: 1,
          },
        ],
      },
      onChange: vi.fn(),
    }),
  );
  await waitFor(() => expect(screen.getByText("Hero")).toBeTruthy());
  fireEvent.click(screen.getByText("Inspect reference"));
  let reject!: (failure: Error) => void;
  vi.mocked(refModOperation).mockReturnValueOnce(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(
    (screen.getByRole("button", { name: "Add files" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Cancel" })
      .closest("fieldset[disabled]"),
  ).toBeNull();
  vi.mocked(refModOperation).mockImplementationOnce(async () => {
    reject(new Error("Local operation was canceled"));
    return { canceled: true };
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Add files" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

it("cancels a preview when its editor is unmounted", async () => {
  let reject!: (failure: Error) => void;
  let operationId = "";
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    operationId = String(request.operationId);
    return new Promise((_resolve, failure) => {
      reject = failure;
    });
  });
  const inspection: RefModInspection = {
    path: "C:/closed.safetensors",
    name: "Closed",
    kind: "image",
    tokens: 4,
    sizeBytes: 1,
    members: [
      {
        key: "latent",
        name: "Closed",
        kind: "image",
        shape: [1, 24, 1, 4, 4],
        tokens: 4,
        frameCount: 1,
        metadata: {},
      },
    ],
  };
  const busy = vi.fn();
  const editor = render(
    createElement(MediaRefModPreview, {
      workspaceRoot: "C:/work",
      inspection,
      visualStrength: 1,
      audioStrength: 1,
      disabled: false,
      onBusyChange: busy,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toEqual({ operation: "cancel", operationId });
    reject(new Error("Local operation was canceled"));
    return { canceled: true };
  });
  editor.unmount();
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
});

it("cancels creation and preserves its sources for a retry", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/source.png");
  vi.mocked(save).mockResolvedValueOnce("C:/created.safetensors");
  const busy = vi.fn();
  const created = vi.fn();
  render(
    createElement(MediaRefModCreator, {
      workspaceRoot: "C:/work",
      disabled: false,
      onBusyChange: busy,
      onCreated: created,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  await waitFor(() => expect(screen.getByText("source.png")).toBeTruthy());
  let reject!: (failure: Error) => void;
  let operationId = "";
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    operationId = String(request.operationId);
    expect(request.operation).toBe("create");
    return new Promise((_resolve, failure) => {
      reject = failure;
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy(),
  );
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toEqual({ operation: "cancel", operationId });
    reject(new Error("Local operation was canceled"));
    return { canceled: true };
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Create and save" }),
    ).toBeTruthy(),
  );
  expect(screen.getByText("source.png")).toBeTruthy();
  expect(created).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("cancels the pending preview by its operation identifier", async () => {
  let reject!: (error: Error) => void;
  let requestedId = "";
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    requestedId = String(request.operationId);
    return new Promise((_resolve, failure) => {
      reject = failure;
    });
  });
  const inspection: RefModInspection = {
    path: "C:/cancel.safetensors",
    name: "Cancel",
    kind: "image",
    tokens: 4,
    sizeBytes: 1,
    members: [
      {
        key: "latent",
        name: "Cancel",
        kind: "image",
        shape: [1, 24, 1, 4, 4],
        tokens: 4,
        frameCount: 1,
        metadata: {},
      },
    ],
  };
  render(
    createElement(MediaRefModPreview, {
      workspaceRoot: "C:/work",
      inspection,
      visualStrength: 1,
      audioStrength: 1,
      disabled: false,
      onBusyChange: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toEqual({ operation: "cancel", operationId: requestedId });
    reject(new Error("RefMod operation was canceled"));
    return { canceled: true };
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy(),
  );
  expect(screen.getByRole("alert").textContent).toContain("canceled");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});

it("hides a preview that finishes after its requested strength changes", async () => {
  const inspection: RefModInspection = {
    path: "C:/reference.safetensors",
    name: "Reference",
    kind: "image",
    tokens: 4,
    sizeBytes: 1,
    members: [
      {
        key: "latent",
        name: "Hero",
        kind: "image",
        shape: [1, 24, 1, 4, 4],
        tokens: 4,
        frameCount: 1,
        metadata: {},
      },
    ],
  };
  let complete!: (value: { kind: string; previews: string[] }) => void;
  vi.mocked(refModOperation).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const props = {
    workspaceRoot: "C:/work",
    inspection,
    visualStrength: 0.8,
    audioStrength: 1,
    disabled: false,
    onBusyChange: vi.fn(),
  };
  const editor = render(createElement(MediaRefModPreview, props));
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare strength" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  editor.rerender(
    createElement(MediaRefModPreview, { ...props, visualStrength: 0.2 }),
  );
  complete({ kind: "image", previews: ["data:image/png;base64,AA=="] });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy(),
  );
  expect(screen.queryByRole("img")).toBeNull();
  vi.mocked(refModOperation).mockResolvedValueOnce({
    kind: "image",
    previews: ["data:image/png;base64,AA=="],
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
});

it("previews logical video frames and resets the frame when selecting another member", async () => {
  const inspection: RefModInspection = {
    path: "C:/video.safetensors",
    name: "Video",
    kind: "bundle",
    tokens: 16,
    sizeBytes: 1,
    members: [
      {
        key: "motion",
        name: "Motion",
        kind: "video",
        shape: [1, 24, 3, 4, 4],
        tokens: 12,
        frameCount: 9,
        metadata: {},
      },
      {
        key: "portrait",
        name: "Portrait",
        kind: "image",
        shape: [1, 24, 1, 4, 4],
        tokens: 4,
        frameCount: 1,
        metadata: {},
      },
    ],
  };
  render(
    createElement(MediaRefModPreview, {
      workspaceRoot: "C:/work",
      inspection,
      visualStrength: 0.5,
      audioStrength: 1,
      disabled: false,
      onBusyChange: vi.fn(),
    }),
  );
  const frame = screen.getByRole("spinbutton", { name: "Frame" });
  expect(frame.getAttribute("max")).toBe("9");
  fireEvent.change(frame, { target: { value: "9" } });
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toMatchObject({
      operation: "preview",
      member: 0,
      frameIndex: 8,
    });
    return { kind: "video", previews: ["data:image/png;base64,AA=="] };
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
  fireEvent.change(frame, { target: { value: "10" } });
  expect((frame as HTMLInputElement).value).toBe("9");
  fireEvent.change(frame, { target: { value: "1" } });
  expect(screen.queryByRole("img")).toBeNull();
  fireEvent.change(frame, { target: { value: "9" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Member" }), {
    target: { value: "1" },
  });
  expect(screen.queryByRole("spinbutton", { name: "Frame" })).toBeNull();
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request).toMatchObject({
      operation: "preview",
      member: 1,
      frameIndex: 0,
    });
    return { kind: "image", previews: ["data:image/png;base64,AA=="] };
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
});

it("updates order, enablement, curves and numbered prompt labels using inspected paths", async () => {
  const insert = vi.fn();
  const initial: MediaRefModSelection[] = [
    "C:/hero.safetensors",
    "C:/voice.safetensors",
  ].map((path) => ({
    path,
    enabled: true,
    selection: "all",
    visualStrength: 1,
    audioStrength: 1,
    copies: 1,
  }));
  function Editor() {
    const [refMods, setRefMods] = useState(initial);
    return createElement(MediaRefModControls, {
      workspaceRoot: "C:/workspace",
      settings: { refMods },
      imageCount: 1,
      onChange: (settings) => setRefMods(settings.refMods ?? []),
      onInsertLabel: insert,
    });
  }
  render(createElement(Editor));
  await waitFor(() => expect(screen.getByText("Hero")).toBeTruthy());
  expect(refModOperation).toHaveBeenCalledWith("C:/workspace", {
    operation: "inspect-many",
    paths: ["C:/hero.safetensors", "C:/voice.safetensors"],
  });
  fireEvent.click(screen.getByRole("button", { name: "<Picture 2>" }));
  expect(insert).toHaveBeenCalledWith("<Picture 2>");
  fireEvent.click(screen.getByRole("button", { name: "Move RefMod 2 up" }));
  expect(screen.getByText("Voice")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable RefMod 1" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "<Audio 1>" })).toBeNull(),
  );
  fireEvent.change(screen.getAllByLabelText("Denoising steps")[1]!, {
    target: { value: "decrease" },
  });
  expect(
    (screen.getAllByLabelText("Denoising steps")[1] as HTMLSelectElement).value,
  ).toBe("decrease");
});
