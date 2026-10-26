// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilePreview } from "./use-file-preview";
import type { FilePreviewTarget } from "./file-preview-runtime";
import { FilePreviewDialog } from "@machdoch/client-ui/file-preview/dialog";

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
  runtime.resolveWorkspaceFilePreviewSource.mockResolvedValue(
    "asset://workspace-chart.png",
  );
  runtime.openWorkspacePath.mockResolvedValue(undefined);
  runtime.revealLocalFile.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("file preview opening", () => {
  it("navigates from a Markdown document through relative documents to an image inside the dialog", async () => {
    runtime.readWorkspaceFilePreview.mockImplementation(
      async (_root, path) => ({
        content:
          path === "docs/start.md"
            ? "[Details](guides/details.md)"
            : "[Chart](../images/chart.png)",
        truncated: false,
        lossy: false,
      }),
    );
    function PreviewHarness() {
      const {
        preview,
        showPreview,
        closePreview,
        openExternally,
        markdownContext,
      } = useFilePreview();
      useEffect(() => {
        showPreview({
          kind: "workspace",
          workspaceRoot: "C:/Project",
          relativePath: "docs/start.md",
        });
      }, [showPreview]);
      return createElement(FilePreviewDialog, {
        preview,
        markdownContext,
        onOpenChange: (open) => {
          if (!open) closePreview();
        },
        onOpenExternal: openExternally,
      });
    }
    render(createElement(PreviewHarness));
    fireEvent.click(
      await screen.findByRole("button", { name: "Show visual preview" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() =>
      expect(runtime.readWorkspaceFilePreview).toHaveBeenCalledWith(
        "C:/Project",
        "docs/guides/details.md",
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show visual preview" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("img", { name: "Preview of chart.png" })
          .getAttribute("src"),
      ).toBe("asset://workspace-chart.png"),
    );
    expect(runtime.resolveWorkspaceFilePreviewSource).toHaveBeenCalledWith(
      "C:/Project",
      "docs/images/chart.png",
    );
    expect(runtime.openWorkspacePath).not.toHaveBeenCalled();
    expect(runtime.revealLocalFile).not.toHaveBeenCalled();
  });

  it("opens a modified file link externally without replacing the current document", async () => {
    runtime.readWorkspaceFilePreview.mockResolvedValue({
      content: "Report",
      truncated: false,
      lossy: false,
    });
    const { result } = renderHook(() => useFilePreview());
    await act(async () =>
      result.current.showPreview({
        kind: "workspace",
        workspaceRoot: "C:/Project",
        relativePath: "docs/start.md",
      }),
    );
    runtime.prepareFilePreview.mockClear();
    await act(async () =>
      result.current.markdownContext?.onOpenWorkspaceFile?.(
        "images/chart.png",
        undefined,
        true,
      ),
    );
    expect(runtime.openWorkspacePath).toHaveBeenCalledWith(
      "C:/Project",
      "images/chart.png",
    );
    expect(runtime.prepareFilePreview).not.toHaveBeenCalled();
    expect(result.current.preview?.path).toBe("docs/start.md");
  });

  it.each(["local", "attachment"] as const)(
    "resolves embedded images beside a %s Markdown document",
    async (kind) => {
      const { result } = renderHook(() => useFilePreview());
      runtime.readAttachedFilePreview.mockResolvedValue({
        content: "Report",
        truncated: false,
        lossy: false,
      });
      const target: FilePreviewTarget =
        kind === "local"
          ? { kind, path: "C:/Temp/docs/report.md" }
          : {
              kind,
              workspaceRoot: "C:/Project",
              attachment: {
                source: "path",
                id: "report",
                name: "report.md",
                kind: "file",
                path: "C:/Temp/docs/report.md",
              },
            };
      await act(async () => result.current.showPreview(target));
      await expect(
        result.current.markdownContext?.resolveImageSource?.("../chart.png"),
      ).resolves.toBe("asset://logo.png");
      expect(runtime.resolveLocalFilePreviewSource).toHaveBeenCalledWith(
        "C:/Temp/chart.png",
      );
    },
  );

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
