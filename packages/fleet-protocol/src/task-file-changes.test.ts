import assert from "node:assert/strict";
import test from "node:test";
import { taskFileChangePageSchema, taskFileChangeHunkPageSchema } from "@machdoch/fleet-protocol/task-file-changes";
import { taskExecutionInsightSchema } from "@machdoch/fleet-protocol/task-execution-insight";

await test("execution insights preserve native verification, related paths and instruction sources", () => {
  const insight = { task: "Grüße 🌿", status: "executed", response: { relatedFiles: [{ path: "notes/Grüße.md", description: "Native file" }], verification: ["Checked the native result"] }, metadata: { instructionResolutionId: "resolution", instructionSources: [{ id: "source", name: "Workspace", scopePath: ".", precedence: 2 }] }, autopilot: { continuationCount: 3 } };
  assert.deepEqual(taskExecutionInsightSchema.parse(insight), insight);
  assert.equal(taskExecutionInsightSchema.safeParse({ ...insight, status: "invented" }).success, false);
});

await test("changed-file pages accept native null cursors and reject malformed counts and extra fields", () => {
  const range = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 };
  const file = { path: "Grüße.md", operation: "added", entryType: "text", oldMode: "000000", newMode: "100644", lineAnalysis: { state: "complete", additions: 2, deletions: 0 }, storedId: 1, hunkCount: 1, ranges: [range] };
  assert.deepEqual(taskFileChangePageSchema.parse({ files: [file], nextCursor: null }), { files: [file], nextCursor: null });
  assert.deepEqual(taskFileChangeHunkPageSchema.parse({ ranges: [range], nextCursor: null }), { ranges: [range], nextCursor: null });
  for (const invalid of [{ ...file, storedId: -1 }, { ...file, hunkCount: 1.5 }, { ...file, operation: "unknown" }, { ...file, unrelated: true }]) assert.equal(taskFileChangePageSchema.safeParse({ files: [invalid] }).success, false);
  assert.equal(taskFileChangeHunkPageSchema.safeParse({ ranges: [{ ...range, newLines: -1 }] }).success, false);
});
