import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalFilePreview,
  resolveLocalFilePreviewSource,
  revealLocalFile,
} from "./local-file-runtime";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  convertFileSrc: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(true);
  native.convertFileSrc.mockReset().mockReturnValue("asset://preview.png");
});

describe("local file link runtime", () => {
  const path = "C:/Temp/My preview.png";

  it("resolves the selected file through the native reader before creating its image source", async () => {
    native.invoke.mockResolvedValue(path);
    expect(await resolveLocalFilePreviewSource(path)).toBe(
      "asset://preview.png",
    );
    expect(native.invoke.mock.calls).toEqual([
      ["resolve_local_file_preview_path", { path }],
    ]);
    expect(native.convertFileSrc).toHaveBeenCalledWith(path);
  });

  it("uses the bounded native reader for documents", async () => {
    const result = { content: "Report", truncated: false, lossy: false };
    native.invoke.mockResolvedValue(result);
    expect(await readLocalFilePreview("/tmp/report.md")).toBe(result);
    expect(native.invoke).toHaveBeenCalledWith("read_local_file_preview", {
      path: "/tmp/report.md",
    });
  });

  it("reveals the file through the file browser", async () => {
    await revealLocalFile(path);
    expect(native.invoke).toHaveBeenCalledWith("reveal_local_file", { path });
  });

  it.each([
    resolveLocalFilePreviewSource,
    readLocalFilePreview,
    revealLocalFile,
  ])("reports native failures instead of hiding them", async (open) => {
    const error = new Error("File no longer exists.");
    native.invoke.mockRejectedValue(error);
    await expect(open(path)).rejects.toBe(error);
    expect(native.convertFileSrc).not.toHaveBeenCalled();
  });

  it.each([
    resolveLocalFilePreviewSource,
    readLocalFilePreview,
    revealLocalFile,
  ])("reports the desktop requirement in browser mode", async (open) => {
    native.isTauri.mockReturnValue(false);
    await expect(open(path)).rejects.toThrow("desktop app");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
