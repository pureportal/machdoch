import { describe, expect, it } from "vitest";
import { productCommandSchema } from "@machdoch/fleet-protocol";
import {
  issueBranchName,
  issueClientPrompt,
  issueSessionTitle,
  taskListProgress,
  toggleTaskListItem,
} from "./issue-text";

const description = [
  "Intro",
  "",
  "- [ ] Import roles",
  "  * [x] Keep IDs",
  "1. [ ] Ordered task",
  "- Plain item with [ ] inside",
].join("\n");

describe("task lists", () => {
  it("toggles the task that starts at the given offset", () => {
    const first = description.indexOf("- [ ] Import");
    const nested = description.indexOf("  * [x]");
    const ordered = description.indexOf("1. [ ]");
    expect(toggleTaskListItem(description, first)).toContain(
      "- [x] Import roles",
    );
    expect(toggleTaskListItem(description, nested + 2)).toContain(
      "  * [ ] Keep IDs",
    );
    expect(toggleTaskListItem(description, ordered)).toContain(
      "1. [x] Ordered task",
    );
    expect(
      toggleTaskListItem(toggleTaskListItem(description, first), first),
    ).toBe(description);
  });

  it("leaves text that is not a task marker unchanged", () => {
    expect(
      toggleTaskListItem(description, description.indexOf("- Plain")),
    ).toBe(description);
    expect(toggleTaskListItem(description, 0)).toBe(description);
  });

  it("counts completed tasks", () => {
    expect(taskListProgress(description)).toEqual({ completed: 1, total: 3 });
    expect(taskListProgress("No tasks")).toEqual({ completed: 0, total: 0 });
  });
});

describe("issueClientPrompt", () => {
  it("drafts the issue for a client session without empty sections", () => {
    expect(
      issueClientPrompt(
        {
          identifier: "PLAT-4",
          title: "Retry fleet handoff",
          description: "  Sessions fail when the device sleeps.\n",
          acceptanceCriteria: "",
        },
        "https://cloud.example.test/cloud/issues/1",
      ),
    ).toBe(
      "PLAT-4: Retry fleet handoff\n\nSessions fail when the device sleeps.\n\nhttps://cloud.example.test/cloud/issues/1",
    );
    expect(
      issueClientPrompt(
        {
          identifier: "PLAT-5",
          title: "Document enrollment",
          description: "",
          acceptanceCriteria: "- Covers SSO",
        },
        "https://cloud.example.test/cloud/issues/2",
      ),
    ).toBe(
      "PLAT-5: Document enrollment\n\nAcceptance criteria:\n- Covers SSO\n\nhttps://cloud.example.test/cloud/issues/2",
    );
  });

  it("keeps session titles within the client protocol limit", () => {
    const title = issueSessionTitle("PLAT-6", "x".repeat(300));
    expect(title.startsWith("PLAT-6 x")).toBe(true);
    expect(
      productCommandSchema.safeParse({
        kind: "rename-session",
        sessionId: "session-1",
        title,
      }).success,
    ).toBe(true);
  });
});

describe("issueBranchName", () => {
  it("combines the identifier with a bounded title slug", () => {
    expect(issueBranchName("CLOUD-2367", "Port role import to Lambda")).toBe(
      "cloud-2367-port-role-import-to-lambda",
    );
    expect(issueBranchName("ENG-1", "Über-fast   «export»!")).toBe(
      "eng-1-uber-fast-export",
    );
    expect(issueBranchName("ENG-2", "!!!")).toBe("eng-2");
    expect(issueBranchName("ENG-3", "a".repeat(59) + " bcd").length).toBe(
      "eng-3-".length + 59,
    );
  });
});
