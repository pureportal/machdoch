import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFilePreview } from "./file-preview-runtime";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(true);
  native.isTauri.mockReturnValue(true);
});

describe("file preview routing", () => {
  it("checks workspace targets through the native resolver", async () => {
    expect(
      await prepareFilePreview({
        kind: "workspace",
        workspaceRoot: " C:/Project ",
        relativePath: "design/logo.png",
        line: 12,
      }),
    ).toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("prepare_file_preview", {
      target: {
        kind: "workspace",
        workspaceRoot: "C:/Project",
        relativePath: "design/logo.png",
      },
      mode: "image",
    });
  });

  it("sends unsupported local files directly to the native explorer route", async () => {
    native.invoke.mockResolvedValue(false);
    expect(
      await prepareFilePreview({ kind: "local", path: "/tmp/archive.zip" }),
    ).toBe(false);
    expect(native.invoke).toHaveBeenCalledWith("prepare_file_preview", {
      target: { kind: "local", path: "/tmp/archive.zip" },
      mode: null,
    });
  });

  it("uses the attachment path to determine support rather than its display name", async () => {
    await prepareFilePreview({
      kind: "attachment",
      attachment: {
        id: "file",
        source: "path",
        kind: "file",
        name: "Report.txt",
        path: "/tmp/report.docx",
      },
      workspaceRoot: undefined,
    });
    expect(native.invoke).toHaveBeenCalledWith("prepare_file_preview", {
      target: {
        kind: "attachment",
        path: "/tmp/report.docx",
        workspaceRoot: null,
      },
      mode: null,
    });
  });

  it("preserves native resolver and explorer failures", async () => {
    const error = new Error("Unable to open the file explorer.");
    native.invoke.mockRejectedValue(error);
    await expect(
      prepareFilePreview({ kind: "local", path: "/tmp/folder" }),
    ).rejects.toBe(error);
  });

  it("reports the desktop requirement before invoking native commands", async () => {
    native.isTauri.mockReturnValue(false);
    await expect(
      prepareFilePreview({ kind: "local", path: "/tmp/folder" }),
    ).rejects.toThrow("desktop app");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
