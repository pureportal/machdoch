import { describe, expect, it } from "vitest";
import {
  formatWorkspaceFileSize,
  reconcileWorkspaceTreeFocus,
  resolveWorkspaceMarkdownPath,
  workspacePathParent,
} from "./workspace-tools-model";

describe("workspace tools model", () => {
  it("normalizes workspace parents across path separators", () => {
    expect(workspacePathParent("README.md")).toBe(".");
    expect(workspacePathParent("src/tauri/ui.tsx")).toBe("src/tauri");
    expect(workspacePathParent("src\\tauri\\ui.tsx")).toBe("src/tauri");
  });

  it("formats compact file sizes", () => {
    expect(formatWorkspaceFileSize(800)).toBe("800 B");
    expect(formatWorkspaceFileSize(1536)).toBe("1.5 KB");
    expect(formatWorkspaceFileSize(12 * 1024 * 1024)).toBe("12 MB");
  });

  it("resolves local Markdown targets without escaping the workspace", () => {
    expect(
      resolveWorkspaceMarkdownPath("docs/guide.md", "../assets/logo.png"),
    ).toBe("assets/logo.png");
    expect(
      resolveWorkspaceMarkdownPath("README.md", "/docs/guide.md#usage"),
    ).toBe("docs/guide.md");
    expect(
      resolveWorkspaceMarkdownPath("docs/guide.md", "%2E%2E/README.md"),
    ).toBe("README.md");
    expect(
      resolveWorkspaceMarkdownPath("README.md", "../outside.md"),
    ).toBeNull();
    expect(
      resolveWorkspaceMarkdownPath("README.md", "https://example.test/a"),
    ).toBeNull();
    expect(resolveWorkspaceMarkdownPath("README.md", "#section")).toBeNull();
  });

  it("keeps the tree roving focus on a visible entry", () => {
    const visible = ["src", "src/main.ts", "README.md"];
    expect(
      reconcileWorkspaceTreeFocus(visible, "src/main.ts", "README.md"),
    ).toBe("src/main.ts");
    expect(
      reconcileWorkspaceTreeFocus(visible, "removed.ts", "README.md"),
    ).toBe("README.md");
    expect(reconcileWorkspaceTreeFocus(visible, "removed.ts", "gone.ts")).toBe(
      "src",
    );
    expect(reconcileWorkspaceTreeFocus([], "removed.ts", null)).toBeNull();
  });
});
