import { describe, expect, it } from "vitest";
import { pullRequestReferences } from "./github-links";

const keys = ["PLAT", "ENG"];

describe("pull request references", () => {
  it("links issues named in the branch or title and closes them on merge", () => {
    expect(
      pullRequestReferences(
        {
          branch: "andreas/plat-12-crash-on-upload",
          title: "ENG-3: Stream uploads",
          body: "",
        },
        keys,
      ),
    ).toEqual([
      { identifier: "PLAT-12", closes: true },
      { identifier: "ENG-3", closes: true },
    ]);
  });

  it("reads closing keywords and references from the description", () => {
    expect(
      pullRequestReferences(
        {
          branch: "main-fixes",
          title: "Upload improvements",
          body: "Fixes PLAT-4, PLAT-5 and plat-6.\nPart of ENG-9\nSee PLAT-77 for context.",
        },
        keys,
      ),
    ).toEqual([
      { identifier: "PLAT-4", closes: true },
      { identifier: "PLAT-5", closes: true },
      { identifier: "PLAT-6", closes: true },
      { identifier: "ENG-9", closes: false },
    ]);
  });

  it("ignores unknown teams, longer tokens and repeated mentions", () => {
    expect(
      pullRequestReferences(
        {
          branch: "xplat-1/ops-2/plat-30x",
          title: "PLAT-8 again PLAT-8",
          body: "Refs PLAT-8",
        },
        keys,
      ),
    ).toEqual([{ identifier: "PLAT-8", closes: true }]);
    expect(
      pullRequestReferences({ branch: "plat-1", title: "", body: "" }, []),
    ).toEqual([]);
  });
});
