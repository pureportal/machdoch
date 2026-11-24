import { describe, expect, it } from "vitest";
import { explainGitError } from "./workspace-git-errors";

describe("git error explanations", () => {
  it("offers to remove a stale lock after confirmation", () => {
    const explained = explainGitError(
      "fatal: Unable to create 'C:/work/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
    );
    expect(explained?.fix).toMatchObject({ action: "remove-index-lock" });
    expect(explained?.fix?.confirm).toContain("no other Git program");
  });

  it("names authentication failures without a fix", () => {
    const explained = explainGitError(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    expect(explained?.cause).toContain("credentials");
    expect(explained?.fix).toBeUndefined();
  });

  it("sets the upstream when the branch has none", () => {
    expect(
      explainGitError(
        "fatal: The current branch feature has no upstream branch.",
      )?.fix?.action,
    ).toBe("set-upstream");
  });

  it("pulls with rebase when the push was rejected or branches diverged", () => {
    expect(
      explainGitError(" ! [rejected]        main -> main (non-fast-forward)")
        ?.fix?.action,
    ).toBe("pull-rebase");
    expect(
      explainGitError("fatal: Not possible to fast-forward, aborting.")?.fix
        ?.action,
    ).toBe("pull-rebase");
    expect(explainGitError("error: pathspec 'x' did not match")).toBeNull();
  });
});
