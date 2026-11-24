import { describe, expect, it } from "vitest";
import {
  canMoveInto,
  EMPTY_FILE_SELECTION,
  remapPathAfterMove,
  selectFilePath,
  topLevelPaths,
  uploadTargetPath,
} from "./workspace-file-selection";

const ordered = ["docs", "docs/a.md", "docs/b.md", "src", "src/main.ts"];
const plain = { toggle: false, range: false };

describe("workspace file selection", () => {
  it("selects single paths, toggles with Ctrl and extends ranges with Shift", () => {
    const single = selectFilePath(
      EMPTY_FILE_SELECTION,
      "docs/a.md",
      ordered,
      plain,
    );
    expect([...single.paths]).toEqual(["docs/a.md"]);

    const toggled = selectFilePath(single, "src/main.ts", ordered, {
      toggle: true,
      range: false,
    });
    expect([...toggled.paths]).toEqual(["docs/a.md", "src/main.ts"]);
    expect([
      ...selectFilePath(toggled, "src/main.ts", ordered, {
        toggle: true,
        range: false,
      }).paths,
    ]).toEqual(["docs/a.md"]);

    const range = selectFilePath(single, "src", ordered, {
      toggle: false,
      range: true,
    });
    expect([...range.paths]).toEqual(["docs/a.md", "docs/b.md", "src"]);
    expect(range.anchor).toBe("docs/a.md");

    const backwards = selectFilePath(
      { paths: new Set(["src"]), anchor: "src" },
      "docs/b.md",
      ordered,
      { toggle: false, range: true },
    );
    expect([...backwards.paths]).toEqual(["docs/b.md", "src"]);
  });

  it("acts on the outermost selected entries only", () => {
    expect(
      topLevelPaths(["docs/a.md", "docs", "src/main.ts", "docs/b.md"]),
    ).toEqual(["docs", "src/main.ts"]);
  });

  it("refuses to move entries into themselves or where they already are", () => {
    expect(canMoveInto(["docs/a.md"], "src")).toBe(true);
    expect(canMoveInto(["docs"], "docs/nested")).toBe(false);
    expect(canMoveInto(["docs/a.md"], "docs")).toBe(false);
    expect(canMoveInto(["src/main.ts"], ".")).toBe(true);
    expect(canMoveInto([], "src")).toBe(false);
  });

  it("remaps paths below a moved folder", () => {
    expect(remapPathAfterMove("docs/a.md", "docs", "archive/docs")).toBe(
      "archive/docs/a.md",
    );
    expect(remapPathAfterMove("docsx/a.md", "docs", "archive/docs")).toBe(
      "docsx/a.md",
    );
  });

  it("builds upload targets inside the drop folder", () => {
    expect(uploadTargetPath(".", "logo.png")).toBe("logo.png");
    expect(uploadTargetPath("assets", "logo.png")).toBe("assets/logo.png");
  });
});
