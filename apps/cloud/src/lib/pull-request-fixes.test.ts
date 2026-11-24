import { describe, expect, it } from "vitest";
import {
  logExcerpt,
  pullRequestFixComment,
  pullRequestFixSubject,
} from "./pull-request-fixes";

const actionsLog = [
  "2026-11-02T10:00:00.0000000Z ##[group]Run pnpm test",
  "2026-11-02T10:00:01.0000000Z \u001b[31mFAIL\u001b[0m src/greeting.test.ts",
  '2026-11-02T10:00:01.1000000Z Expected: "Guten Tag"',
  '2026-11-02T10:00:01.2000000Z Received: "Hallo"',
  "2026-11-02T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
  "2026-11-02T10:00:03.0000000Z Post job cleanup.",
  "2026-11-02T10:00:04.0000000Z Cleaning up orphan processes",
].join("\n");

describe("pull request fixes", () => {
  it("keeps the end of a failed step without timestamps, colours or cleanup", () => {
    expect(logExcerpt(actionsLog, 1_000)).toBe(
      [
        "##[group]Run pnpm test",
        "FAIL src/greeting.test.ts",
        'Expected: "Guten Tag"',
        'Received: "Hallo"',
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
  });

  it("cuts long logs from the start and marks the cut", () => {
    const log = Array.from({ length: 100 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    const excerpt = logExcerpt(log, 30);
    expect(excerpt.split("\n")[0]).toBe("…");
    expect(excerpt.endsWith("line 99")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(32);
  });

  it("puts each failed check log in the objective and asks for the cause", () => {
    const subject = pullRequestFixSubject("checks", {
      failures: [
        {
          name: "unit",
          url: "https://github.com/acme/app/runs/1",
          log: actionsLog,
        },
        { name: "lint", url: null, log: "" },
      ],
      comments: [],
    });
    expect(subject.objective).toContain(
      "## unit\nhttps://github.com/acme/app/runs/1\n```text\n##[group]Run pnpm test",
    );
    expect(subject.objective).toContain('Received: "Hallo"');
    expect(subject.objective).not.toContain("Post job cleanup");
    expect(subject.objective).toContain(
      "## lint\nThe provider returned no log for this check.",
    );
    expect(subject.objective).toContain(
      "Start your summary with the cause of each failure",
    );
    expect(subject.acceptanceCriteria).toContain("cause of each failure");
  });

  it("keeps the objective within the task limit for many long logs", () => {
    const log = "x".repeat(50_000);
    const subject = pullRequestFixSubject("checks", {
      failures: Array.from({ length: 12 }, (_, index) => ({
        name: `check ${index}`,
        url: null,
        log: `${log}\nerror ${index}`,
      })),
      comments: [],
    });
    expect(subject.objective.length).toBeLessThan(20_000);
    expect(subject.objective).toContain("error 7");
    expect(subject.objective).not.toContain("check 8");
  });

  it("lists review comments with their location and asks what changed for each", () => {
    const subject = pullRequestFixSubject("review", {
      failures: [],
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "  Rename this value.\n",
          path: "src/sign-in.ts",
          line: 3,
          diffHunk: "@@ -1 +1 @@",
          url: "https://github.com/acme/app/pull/12#discussion_r1",
          createdAt: "2026-11-01T10:00:00Z",
        },
        {
          id: 2,
          author: "lead",
          body: "Split this file.",
          path: "src/passkeys.ts",
          line: null,
          diffHunk: "@@ -1 +1 @@",
          url: "https://github.com/acme/app/pull/12#discussion_r2",
          createdAt: "2026-11-01T11:00:00Z",
        },
      ],
    });
    expect(subject.objective).toContain(
      "## src/sign-in.ts:3 (reviewer)\nRename this value.\nhttps://github.com/acme/app/pull/12#discussion_r1",
    );
    expect(subject.objective).toContain("## src/passkeys.ts (lead)");
    expect(subject.objective).toContain("what you changed for each comment");
  });

  it("posts the summary with the changed files", () => {
    const comment = pullRequestFixComment({
      purpose: "fix",
      summary: "The test expected the formal greeting.\n",
      changes: [
        {
          path: "locales/de.json",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
        },
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
          binary: false,
        },
        {
          path: "logo.png",
          previousPath: null,
          status: "added",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ],
      review: "",
      link: "[Open the task](https://cloud.example.test/cloud/tasks/1)",
    });
    expect(comment).toBe(
      [
        "**Machdoch fix:** The test expected the formal greeting.",
        "**Changed files**\n- `locales/de.json` +1 −1\n- `src/old.ts` → `src/new.ts` +0 −0\n- `logo.png` (added)",
        "[Open the task](https://cloud.example.test/cloud/tasks/1)",
      ].join("\n\n"),
    );
    expect(
      pullRequestFixComment({
        purpose: "resolve",
        summary: null,
        changes: [],
        review: "",
        link: "link",
      }),
    ).toBe("**Machdoch conflict resolution:** Pushed a change.\n\nlink");
  });
});
