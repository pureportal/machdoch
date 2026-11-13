import { describe, expect, it } from "vitest";
import {
  hiddenPropertyList,
  parseHiddenIssueProperties,
  parseHiddenPropertyList,
  toggleIssueProperty,
} from "./issue-display";

describe("issue display properties", () => {
  it("hides the created date until the user chooses otherwise", () => {
    expect([...parseHiddenIssueProperties(null)]).toEqual(["created"]);
    expect([...parseHiddenIssueProperties("[]")]).toEqual([]);
  });

  it("ignores unknown and malformed stored values", () => {
    expect([
      ...parseHiddenIssueProperties('["labels","owner",3,"cycle"]'),
    ]).toEqual(["labels", "cycle"]);
    expect([...parseHiddenIssueProperties("{")]).toEqual(["created"]);
    expect([...parseHiddenIssueProperties('{"labels":true}')]).toEqual([
      "created",
    ]);
  });

  it("toggles one property and keeps a stable order", () => {
    const hidden = parseHiddenIssueProperties('["updated","labels"]');
    expect(toggleIssueProperty(hidden, "project")).toEqual([
      "labels",
      "project",
      "updated",
    ]);
    expect(toggleIssueProperty(hidden, "labels")).toEqual(["updated"]);
  });

  it("round-trips the list stored in a view", () => {
    const hidden = parseHiddenPropertyList("updated,owner,,status");
    expect([...hidden]).toEqual(["updated", "status"]);
    expect(hiddenPropertyList(hidden)).toBe("status,updated");
    expect([...parseHiddenPropertyList("")]).toEqual([]);
  });
});
