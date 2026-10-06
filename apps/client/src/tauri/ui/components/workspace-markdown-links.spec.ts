import { describe, expect, it, vi } from "vitest";
import {
  getLocalMarkdownLinkTarget,
  getWorkspaceMarkdownLinkTarget,
  isLocalMarkdownLinkHref,
  openWorkspaceMarkdownLinkTarget,
} from "@machdoch/client-ui/conversation/workspace-markdown-links";

const WINDOWS_WORKSPACE =
  "C:\\Development\\alpartis.morgana\\app.alpartis.cloud";
const WINDOWS_SOURCE_PATH =
  "C:/Development/alpartis.morgana/app.alpartis.cloud/src/common/helpers/get-branch-label.ts";

describe("getLocalMarkdownLinkTarget", () => {
  it.each([
    [
      "C:/Users/ehrha/AppData/Local/Temp/machdoch-goal-ui-review/final-composer-desktop.png",
      "C:/Users/ehrha/AppData/Local/Temp/machdoch-goal-ui-review/final-composer-desktop.png",
    ],
    ["C:\\Temp\\My preview.png", "C:/Temp/My preview.png"],
    ["/C:/Temp/My%20preview.png", "C:/Temp/My preview.png"],
    ["file:///C:/Temp/My%20preview.png", "C:/Temp/My preview.png"],
    ["file:///tmp/My%20preview.png", "/tmp/My preview.png"],
    ["file://server/share/My%20preview.png", "//server/share/My preview.png"],
    ["\\\\server\\share\\preview.png", "//server/share/preview.png"],
    ["\\\\?\\C:\\Temp\\preview.png", "C:/Temp/preview.png"],
  ])("resolves an absolute file target %s", (href, path) => {
    expect(getLocalMarkdownLinkTarget(href)).toEqual({ path });
  });

  it("preserves source locations for absolute documents", () => {
    expect(getLocalMarkdownLinkTarget("C:/Temp/report.md:12:3")).toEqual({
      path: "C:/Temp/report.md",
      line: 12,
      column: 3,
    });
    expect(getLocalMarkdownLinkTarget("file:///tmp/report.md#L12")).toEqual({
      path: "/tmp/report.md",
      line: 12,
    });
  });

  it.each([
    undefined,
    "",
    "docs/guide.md",
    "#section",
    "https://example.com/preview.png",
    "javascript:alert(1)",
    "data:text/html,test",
    "C:relative.png",
    "C:/Temp/../preview.png",
    "C:/Temp/%2e%2e/preview.png",
    "file:///tmp/%2e%2e/preview.png",
    "file:///tmp/preview%00.png",
  ])("rejects non-absolute or unsafe file targets %s", (href) => {
    expect(getLocalMarkdownLinkTarget(href)).toBeNull();
  });
});

describe("getWorkspaceMarkdownLinkTarget", () => {
  it("resolves a Windows workspace path and preserves its trailing line", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        `${WINDOWS_SOURCE_PATH}:13`,
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "src/common/helpers/get-branch-label.ts",
      line: 13,
    });
  });

  it("accepts URI-style Windows drive paths and preserves line and column", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        "/C:/Development/alpartis.morgana/app.alpartis.cloud/src/branch.dto.ts:27:9",
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "src/branch.dto.ts",
      line: 27,
      column: 9,
    });
  });

  it("normalizes backslash paths with a line suffix", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        "C:\\Development\\alpartis.morgana\\app.alpartis.cloud\\src\\branch.dto.ts:8",
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "src/branch.dto.ts",
      line: 8,
    });
  });

  it("preserves source lines from file URL hashes", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        "file:///C:/Development/alpartis.morgana/app.alpartis.cloud/docs/My%20Report.md#L12",
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "docs/My Report.md",
      line: 12,
    });
  });

  it("recognizes encoded source-line suffixes after decoding Markdown hrefs", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        `${WINDOWS_SOURCE_PATH}%3A19`,
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "src/common/helpers/get-branch-label.ts",
      line: 19,
    });
  });

  it("keeps paths without source locations openable without a line", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(WINDOWS_SOURCE_PATH, WINDOWS_WORKSPACE),
    ).toEqual({
      relativePath: "src/common/helpers/get-branch-label.ts",
    });
    expect(getWorkspaceMarkdownLinkTarget("src/branch.dto.ts", null)).toEqual({
      relativePath: "src/branch.dto.ts",
    });
  });

  it("ignores ordinary query strings and fragments on workspace files", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        "docs/My%20Report.md?view=preview#summary",
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "docs/My Report.md",
    });
  });

  it("uses platform-appropriate path casing and supports a POSIX root workspace", () => {
    expect(
      getWorkspaceMarkdownLinkTarget(
        WINDOWS_SOURCE_PATH.toUpperCase(),
        WINDOWS_WORKSPACE,
      ),
    ).toEqual({
      relativePath: "SRC/COMMON/HELPERS/GET-BRANCH-LABEL.TS",
    });
    expect(
      getWorkspaceMarkdownLinkTarget(
        "/home/Owner/project/src/main.ts",
        "/home/Owner/project",
      ),
    ).toEqual({ relativePath: "src/main.ts" });
    expect(
      getWorkspaceMarkdownLinkTarget(
        "/home/owner/project/src/main.ts",
        "/home/Owner/project",
      ),
    ).toBeNull();
    expect(getWorkspaceMarkdownLinkTarget("/etc/hosts", "/")).toEqual({
      relativePath: "etc/hosts",
    });
  });

  it("keeps outside-workspace, unsafe, and non-path targets unsupported", () => {
    expect(
      getWorkspaceMarkdownLinkTarget("C:/Other/secret.ts:1", WINDOWS_WORKSPACE),
    ).toBeNull();
    expect(
      getWorkspaceMarkdownLinkTarget("src/../secret.ts:1", WINDOWS_WORKSPACE),
    ).toBeNull();
    expect(
      getWorkspaceMarkdownLinkTarget("src/%2e%2e/secret.ts", WINDOWS_WORKSPACE),
    ).toBeNull();
    expect(
      getWorkspaceMarkdownLinkTarget(
        "https://example.com/source.ts:1",
        WINDOWS_WORKSPACE,
      ),
    ).toBeNull();
  });
});

describe("isLocalMarkdownLinkHref", () => {
  it("recognizes supported Windows source-location forms without treating web URLs as paths", () => {
    expect(isLocalMarkdownLinkHref(`${WINDOWS_SOURCE_PATH}:13`)).toBe(true);
    expect(isLocalMarkdownLinkHref(`/${WINDOWS_SOURCE_PATH}:13`)).toBe(true);
    expect(isLocalMarkdownLinkHref("docs/guide.md#usage")).toBe(true);
    expect(isLocalMarkdownLinkHref("https://example.com/file.ts:13")).toBe(
      false,
    );
    expect(isLocalMarkdownLinkHref("javascript:alert(1)")).toBe(false);
  });
});

describe("openWorkspaceMarkdownLinkTarget", () => {
  it("forwards the parsed path and line to the file-preview handler", () => {
    const onOpen = vi.fn();

    openWorkspaceMarkdownLinkTarget(
      {
        relativePath: "src/common/helpers/get-branch-label.ts",
        line: 13,
      },
      onOpen,
    );

    expect(onOpen).toHaveBeenCalledWith(
      "src/common/helpers/get-branch-label.ts",
      13,
    );
  });

  it("keeps no-line targets compatible with normal file preview opening", () => {
    const onOpen = vi.fn();

    openWorkspaceMarkdownLinkTarget(
      {
        relativePath: "src/branch.dto.ts",
      },
      onOpen,
    );

    expect(onOpen).toHaveBeenCalledWith("src/branch.dto.ts", undefined);
  });
});
