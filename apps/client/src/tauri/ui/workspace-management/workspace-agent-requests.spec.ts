import { describe, expect, it } from "vitest";
import {
  conflictResolutionPrompt,
  diffReviewPrompt,
  failedChecksPrompt,
  failedGitActionPrompt,
} from "./workspace-agent-requests";

describe("workspace agent requests", () => {
  it("names the repository, the file and the material the agent needs", () => {
    const diff = diffReviewPrompt("api", "src/main.ts", "@@ -1 +1 @@\n-a\n+b");
    expect(diff).toContain("`src/main.ts` in `api`");
    expect(diff).toContain("```diff\n@@ -1 +1 @@\n-a\n+b\n```");

    const conflict = conflictResolutionPrompt(
      "api",
      "a.ts",
      "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main",
    );
    expect(conflict).toContain("Do not stage it");
    expect(conflict).toContain("<<<<<<< HEAD");

    expect(failedGitActionPrompt("api", "push", "rejected")).toContain(
      "`git push` failed in `api`",
    );

    expect(
      failedChecksPrompt(
        "api",
        { number: 7, title: "Fix", headBranch: "cloud-1-fix" },
        [{ name: "lint", url: "https://ci/1" }, { name: "test" }],
      ),
    ).toContain("- lint (https://ci/1)\n- test");
  });

  it("keeps large excerpts bounded and fences intact", () => {
    const prompt = diffReviewPrompt(
      "api",
      "big.txt",
      `${"x".repeat(13_000)}\`\`\``,
    );
    expect(prompt).toContain("more characters");
    expect(prompt.match(/```/gu)).toHaveLength(2);
  });
});
