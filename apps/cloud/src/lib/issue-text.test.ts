import { describe, expect, it } from "vitest";
import {
  issueBranchName,
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
