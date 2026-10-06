// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaRefModCreator } from "./media-refmod-creator";
import { open, pickedFileName, releaseFile, save } from "../media-platform";
import { refModOperation, type RefModInspection } from "../media-refmods";

vi.mock("../media-platform", () => ({
  open: vi.fn(),
  save: vi.fn(),
  releaseFile: vi.fn(async () => undefined),
  isRemoteMedia: () => true,
  pickedFileName: vi.fn((path: string) => path.split(/[\\/]/u).at(-1)!),
}));
vi.mock("../media-refmods", () => ({ refModOperation: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pickedFileName).mockImplementation((path) =>
    path.split(/[\\/]/u).at(-1)!,
  );
});
afterEach(cleanup);

const renderCreator = (onCreated = vi.fn()) =>
  render(
    createElement(MediaRefModCreator, {
      workspaceRoot: "C:/work",
      disabled: false,
      onBusyChange: vi.fn(),
      onCreated,
    }),
  );
const addImage = async (path = "C:/uploads/source.png") => {
  vi.mocked(open).mockResolvedValueOnce([path]);
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  await waitFor(() =>
    expect(screen.getByText(path.split("/").at(-1)!)).toBeTruthy(),
  );
};

it("uses original upload names for the source, mask and suggested RefMod name", async () => {
  renderCreator();
  vi.mocked(open).mockResolvedValueOnce(["C:/uploads/transfer-portrait.png"]);
  vi.mocked(pickedFileName).mockImplementation((path) =>
    path.endsWith("portrait.png") ? "portrait.png" : "mask.png",
  );
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "portrait",
    ),
  );
  vi.mocked(open).mockResolvedValueOnce("C:/uploads/transfer-mask.png");
  fireEvent.click(screen.getByRole("button", { name: "Choose mask" }));
  await waitFor(() => expect(screen.getByText("mask.png")).toBeTruthy());
  expect(screen.getByText("portrait.png")).toBeTruthy();
  expect(screen.queryByText("transfer-portrait.png")).toBeNull();
  expect(screen.queryByText("transfer-mask.png")).toBeNull();
});

it("releases replaced and removed masks without discarding the selected image", async () => {
  const editor = renderCreator();
  await addImage();
  for (const name of ["first.png", "second.png"]) {
    vi.mocked(open).mockResolvedValueOnce(`C:/uploads/${name}`);
    fireEvent.click(screen.getByRole("button", { name: "Choose mask" }));
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  }
  expect(releaseFile).toHaveBeenCalledExactlyOnceWith("C:/uploads/first.png");
  fireEvent.click(screen.getByRole("button", { name: "Remove mask" }));
  await waitFor(() => expect(screen.queryByText("second.png")).toBeNull());
  expect(releaseFile).toHaveBeenCalledWith("C:/uploads/second.png");
  expect(screen.getByText("source.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByText("source.png")).toBeNull());
  editor.unmount();
  await waitFor(() => expect(releaseFile).toHaveBeenCalledTimes(3));
});

it("preserves failed creation inputs for retry and releases them when closed", async () => {
  const editor = renderCreator();
  await addImage();
  vi.mocked(open).mockResolvedValueOnce("C:/uploads/mask.png");
  fireEvent.click(screen.getByRole("button", { name: "Choose mask" }));
  await waitFor(() => expect(screen.getByText("mask.png")).toBeTruthy());
  vi.mocked(save).mockResolvedValueOnce("C:/downloads/reference.safetensors");
  vi.mocked(refModOperation).mockRejectedValueOnce(
    new Error("Install the MiniMax H3 video VAE"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Install"),
  );
  expect(screen.getByText("source.png")).toBeTruthy();
  expect(screen.getByText("mask.png")).toBeTruthy();
  expect(releaseFile).not.toHaveBeenCalled();
  editor.unmount();
  await waitFor(() => expect(releaseFile).toHaveBeenCalledTimes(2));
});

it("releases a file picker result arriving after the creator closes", async () => {
  let choose!: (value: string[]) => void;
  vi.mocked(open).mockReturnValueOnce(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  const editor = renderCreator();
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  editor.unmount();
  await act(async () => choose(["C:/uploads/late.png"]));
  await waitFor(() =>
    expect(releaseFile).toHaveBeenCalledExactlyOnceWith("C:/uploads/late.png"),
  );
});

it("waits for closed creation to settle before releasing its source and ignores its late result", async () => {
  const created = vi.fn();
  const editor = renderCreator(created);
  await addImage();
  vi.mocked(save).mockResolvedValueOnce("C:/downloads/reference.safetensors");
  let finish!: (value: RefModInspection) => void;
  vi.mocked(refModOperation).mockImplementationOnce(async (_root, request) => {
    expect(request.operation).toBe("create");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy(),
  );
  vi.mocked(refModOperation).mockResolvedValueOnce({ canceled: true });
  editor.unmount();
  expect(refModOperation).toHaveBeenLastCalledWith(
    "C:/work",
    expect.objectContaining({ operation: "cancel" }),
  );
  expect(releaseFile).not.toHaveBeenCalled();
  await act(async () =>
    finish({
      path: "C:/work/models/refmods/reference.safetensors",
    } as RefModInspection),
  );
  await waitFor(() =>
    expect(releaseFile).toHaveBeenCalledExactlyOnceWith(
      "C:/uploads/source.png",
    ),
  );
  expect(created).not.toHaveBeenCalled();
});

it("keeps the source selected if release fails so removal can be retried", async () => {
  const editor = renderCreator();
  await addImage();
  vi.mocked(releaseFile).mockRejectedValueOnce(new Error("Disconnected"));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Try again"),
  );
  expect(screen.getByText("source.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByText("source.png")).toBeNull());
  editor.unmount();
  expect(releaseFile).toHaveBeenCalledTimes(2);
});
