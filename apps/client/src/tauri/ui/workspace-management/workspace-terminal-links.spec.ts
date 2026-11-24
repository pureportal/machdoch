import { describe, expect, it } from "vitest";
import {
  findTerminalFileLinks,
  resolveTerminalLinkPath,
} from "./workspace-terminal-links";

describe("terminal file links", () => {
  it("finds compiler and stack trace locations", () => {
    expect(
      findTerminalFileLinks("src/app.ts:12:5 - error TS2322: Type mismatch"),
    ).toEqual([{ start: 0, end: 15, path: "src/app.ts", line: 12, column: 5 }]);
    expect(findTerminalFileLinks("  --> src\\main.rs:40:9")[0]).toMatchObject({
      path: "src\\main.rs",
      line: 40,
      column: 9,
    });
    expect(findTerminalFileLinks("lib/index.ts(7,3): error")[0]).toMatchObject({
      path: "lib/index.ts",
      line: 7,
      column: 3,
    });
    expect(
      findTerminalFileLinks("at C:\\work\\app\\file.js:3")[0],
    ).toMatchObject({
      path: "C:\\work\\app\\file.js",
      line: 3,
      column: null,
    });
  });

  it("ignores URLs and version numbers", () => {
    expect(
      findTerminalFileLinks("see https://example.test/docs/page.html"),
    ).toEqual([]);
    expect(findTerminalFileLinks("node v24.18.0 ready")).toEqual([]);
  });

  it("resolves links against the terminal folder and the workspace", () => {
    expect(
      resolveTerminalLinkPath(
        { path: "src/app.ts" },
        "C:\\Work\\app",
        "C:\\Work\\app\\packages\\ui",
      ),
    ).toEqual({ relativePath: "packages/ui/src/app.ts" });
    expect(
      resolveTerminalLinkPath(
        { path: "..\\shared\\x.ts" },
        "C:\\Work\\app",
        "C:\\work\\app\\packages\\ui",
      ),
    ).toEqual({ relativePath: "packages/shared/x.ts" });
    expect(
      resolveTerminalLinkPath({ path: "/etc/hosts.txt" }, "/home/me/app", null),
    ).toEqual({
      absolutePath: "/etc/hosts.txt",
    });
  });
});
