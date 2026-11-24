import { describe, expect, it } from "vitest";
import {
  buildFileDecorations,
  decorationForChange,
  decorationForPath,
} from "./workspace-file-decorations";

const change = (status: string, path: string, extra = {}) => ({
  status,
  path,
  untracked: status === "??",
  conflicted: status === "UU",
  ...extra,
});

describe("file tree Git decorations", () => {
  it("maps porcelain states to decorations", () => {
    expect(decorationForChange(change(" M", "a"))).toBe("modified");
    expect(decorationForChange(change("A ", "a"))).toBe("added");
    expect(decorationForChange(change("R ", "a"))).toBe("renamed");
    expect(decorationForChange(change(" D", "a"))).toBe("deleted");
    expect(decorationForChange(change("??", "a"))).toBe("untracked");
    expect(decorationForChange(change("UU", "a"))).toBe("conflicted");
    expect(decorationForChange(change("!!", "a"))).toBe("ignored");
  });

  it("rolls the strongest child state up to every parent folder, across nested repositories", () => {
    const index = buildFileDecorations([
      {
        relativePath: ".",
        changes: [
          change("??", "src/new.ts"),
          change(" M", "src/lib/util.ts"),
          change("??", "generated/"),
          change("!!", "dist/"),
        ],
      },
      {
        relativePath: "services/api",
        changes: [change("UU", "src/server.ts")],
      },
    ]);
    expect(decorationForPath(index, "src", "directory")).toBe("modified");
    expect(decorationForPath(index, "src/lib", "directory")).toBe("modified");
    expect(decorationForPath(index, "src/new.ts", "file")).toBe("untracked");
    expect(decorationForPath(index, "services", "directory")).toBe(
      "conflicted",
    );
    expect(decorationForPath(index, "services/api/src/server.ts", "file")).toBe(
      "conflicted",
    );
    expect(decorationForPath(index, "generated/a/b.txt", "file")).toBe(
      "untracked",
    );
    expect(decorationForPath(index, "dist", "directory")).toBe("ignored");
    expect(decorationForPath(index, "dist/app.js", "file")).toBe("ignored");
    expect(decorationForPath(index, "README.md", "file")).toBeUndefined();
  });
});
