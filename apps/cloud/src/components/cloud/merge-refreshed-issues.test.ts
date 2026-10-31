import { expect, it } from "vitest";
import type { CloudIssueSummary } from "@/lib/cloud-contract";
import { mergeRefreshedIssues } from "./merge-refreshed-issues";

function issue(id: string, title = id) {
  return { id, title } as CloudIssueSummary;
}

it("keeps loaded pages and their local edits across a live refresh", () => {
  expect(
    mergeRefreshedIssues(
      [issue("first", "renamed")],
      [issue("first"), issue("second", "edited"), issue("third")],
      new Set(["second"]),
    ),
  ).toEqual([issue("first", "renamed"), issue("second", "edited")]);
});

it("prefers the refreshed copy once a loaded issue reaches the first page", () => {
  expect(
    mergeRefreshedIssues(
      [issue("second", "refreshed")],
      [issue("first"), issue("second", "stale")],
      new Set(["second"]),
    ),
  ).toEqual([issue("second", "refreshed")]);
});
