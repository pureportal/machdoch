// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilePreview } from "./use-file-preview";
import type { FilePreviewTarget } from "./file-preview-runtime";

const runtime = vi.hoisted(() => ({
  prepareFilePreview: vi.fn(),
  readLocalFilePreview: vi.fn(),
  resolveLocalFilePreviewSource: vi.fn(),
  revealLocalFile: vi.fn(),
  readAttachedFilePreview: vi.fn(),
  readWorkspaceFilePreview: vi.fn(),
  resolveAttachedFilePreviewSource: vi.fn(),
  resolveWorkspaceFilePreviewSource: vi.fn(),
  openAttachedPath: vi.fn(),
  openWorkspacePath: vi.fn(),
}));
vi.mock("./file-preview-runtime", () => runtime);
vi.mock("../../local-file-runtime", () => runtime);
vi.mock("../../runtime", () => runtime);

beforeEach(() => {
  for (const mock of Object.values(runtime)) {
    mock.mockReset();
  }
  runtime.prepareFilePreview.mockResolvedValue(true);
  runtime.readLocalFilePreview.mockResolvedValue({
    content: "Report",
    truncated: false,
    lossy: false,
  });
  runtime.resolveLocalFilePreviewSource.mockResolvedValue("asset://logo.png");
});
afterEach(cleanup);

describe("file preview opening", () => {
  it.each([
    {
      kind: "workspace",
      workspaceRoot: "/project",
      relativePath: "PurePortal Logo Variants",
    },
    {
      kind: "workspace",
      workspaceRoot: "/project",
      relativePath: "folder.png",
    },
    { kind: "local", path: "/tmp/archive.zip" },
    {
      kind: "attachment",
      workspaceRoot: "/project",
      attachment: {
        id: "binary",
        source: "path",
        kind: "file",
        name: "binary.txt",
        path: "/project/binary.txt",
      },
    },
  ] satisfies FilePreviewTarget[])(
    "keeps externally opened targets out of the preview dialog: $kind",
    async (target) => {
      runtime.prepareFilePreview.mockResolvedValue(false);
      const { result } = renderHook(() => useFilePreview());
      await act(async () => result.current.showPreview(target));
      expect(result.current.preview).toBeNull();
      expect(runtime.prepareFilePreview).toHaveBeenCalledWith(target);
      for (const reader of [
        runtime.readLocalFilePreview,
        runtime.readWorkspaceFilePreview,
        runtime.readAttachedFilePreview,
        runtime.resolveLocalFilePreviewSource,
        runtime.resolveWorkspaceFilePreviewSource,
        runtime.resolveAttachedFilePreviewSource,
      ]) {
        expect(reader).not.toHaveBeenCalled();
      }
    },
  );

  it("continues previewing supported text files at the requested line", async () => {
    const { result } = renderHook(() => useFilePreview());
    await act(async () =>
      result.current.showPreview({
        kind: "local",
        path: "/tmp/report.md",
        line: 2,
      }),
    );
    expect(result.current.preview).toMatchObject({
      mode: "text",
      content: "Report",
      loading: false,
      error: null,
      targetLine: 2,
    });
  });

  it.each(["workspace", "attachment"] as const)(
    "keeps supported %s files on their own reader",
    async (kind) => {
      runtime.readWorkspaceFilePreview.mockResolvedValue({
        content: "Workspace report",
        truncated: false,
        lossy: false,
      });
      runtime.readAttachedFilePreview.mockResolvedValue({
        content: "Attached report",
        truncated: false,
        lossy: false,
      });
      const target: FilePreviewTarget =
        kind === "workspace"
          ? {
              kind,
              workspaceRoot: "/project",
              relativePath: "report.md",
              line: 3,
            }
          : {
              kind,
              workspaceRoot: "/project",
              attachment: {
                id: "report",
                source: "path",
                kind: "file",
                name: "Report",
                path: "/project/report.md",
              },
            };
      const { result } = renderHook(() => useFilePreview());
      await act(async () => result.current.showPreview(target));
      expect(result.current.preview).toMatchObject({
        mode: "text",
        content: kind === "workspace" ? "Workspace report" : "Attached report",
        loading: false,
        error: null,
      });
      if (kind === "workspace") {
        expect(runtime.readWorkspaceFilePreview).toHaveBeenCalledWith(
          "/project",
          "report.md",
        );
      } else {
        expect(runtime.readAttachedFilePreview).toHaveBeenCalledWith(
          "/project/report.md",
          "/project",
        );
      }
      expect(runtime.readLocalFilePreview).not.toHaveBeenCalled();
    },
  );

  it.each(["png", "pdf"])(
    "continues previewing supported %s files",
    async (extension) => {
      const { result } = renderHook(() => useFilePreview());
      await act(async () =>
        result.current.showPreview({
          kind: "local",
          path: `/tmp/preview.${extension}`,
        }),
      );
      expect(result.current.preview).toMatchObject({
        mode: extension === "png" ? "image" : "pdf",
        source: "asset://logo.png",
        loading: false,
        error: null,
      });
    },
  );

  it("shows explorer failures so the user can recover", async () => {
    runtime.prepareFilePreview.mockRejectedValue(
      "File explorer could not open the requested path.",
    );
    const { result } = renderHook(() => useFilePreview());
    await act(async () =>
      result.current.showPreview({ kind: "local", path: "/tmp/archive.zip" }),
    );
    expect(result.current.preview).toMatchObject({
      loading: false,
      error: "File explorer could not open the requested path.",
    });
  });

  it("does not reopen a preview after it was closed during preparation", async () => {
    let resolvePreparation!: (value: boolean) => void;
    runtime.prepareFilePreview.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePreparation = resolve;
      }),
    );
    const { result } = renderHook(() => useFilePreview());
    act(() =>
      result.current.showPreview({ kind: "local", path: "/tmp/report.md" }),
    );
    act(() => result.current.closePreview());
    await act(async () => resolvePreparation(true));
    expect(result.current.preview).toBeNull();
    expect(runtime.readLocalFilePreview).not.toHaveBeenCalled();
  });

  it("ignores a previous load when a newer target opens externally", async () => {
    let resolveContent!: (value: {
      content: string;
      truncated: boolean;
      lossy: boolean;
    }) => void;
    runtime.readLocalFilePreview.mockReturnValue(
      new Promise((resolve) => {
        resolveContent = resolve;
      }),
    );
    const { result } = renderHook(() => useFilePreview());
    await act(async () =>
      result.current.showPreview({ kind: "local", path: "/tmp/report.md" }),
    );
    runtime.prepareFilePreview.mockResolvedValue(false);
    await act(async () =>
      result.current.showPreview({ kind: "local", path: "/tmp/archive.zip" }),
    );
    await act(async () =>
      resolveContent({
        content: "Old content",
        truncated: false,
        lossy: false,
      }),
    );
    expect(result.current.preview).toBeNull();
  });
});
