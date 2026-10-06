import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskExecutionFileChanges } from "@machdoch/fleet-protocol/task-file-changes";
import type { ProductMessage } from "@machdoch/fleet-protocol";
import { RemoteExecutionInsight } from "./remote-execution-insight";

const stage = { state: "complete" } as const;
const changes: TaskExecutionFileChanges = {
  files: [], changeSetId: "native-set", totalFiles: 2, additions: 3, deletions: 1,
  binaryFiles: 0, gitlinkFiles: 0, symlinkFiles: 0, modeOnlyFiles: 0, failedFiles: 0,
  status: "complete", completeness: { discovery: stage, startSnapshots: stage, finishSnapshots: stage, renameAnalysis: stage, lineAnalysis: stage, persistence: stage },
  attribution: "workspace-observed", repositoryCount: 1, issues: [],
};
const range = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 };
const file = { path: "notes/Grüße.md", operation: "modified", entryType: "text", oldMode: "100644", newMode: "100644", lineAnalysis: { state: "complete", additions: 3, deletions: 1 }, storedId: 1, hunkCount: 3, ranges: [range, { ...range, oldStart: 5, newStart: 6 }] };
const message: ProductMessage = { id: "native-message", role: "agent", taskId: "native-task", content: "Complete", presentation: "message", attachments: [], actions: { canRetry: true, canContinue: true, canSaveAsContextPack: false, canSpeak: false, isSpeaking: false } };
const execution = { task: "Native task", status: "executed", fileChanges: changes, response: { relatedFiles: [{ path: "notes/related.md", description: "Native reference" }], verification: ["Checked"] }, metadata: { instructionResolutionId: "resolution", instructionSources: [{ id: "source", name: "Workspace instructions", scopePath: "." }] } } as const;
afterEach(cleanup);

it("pages native changed files and line ranges with the owning session and message", async () => {
  const invoke = vi.fn().mockImplementation(async (command, args) => {
    if (command === "get_session_file_change_hunks") return { ranges: [{ ...range, oldStart: 9, newStart: 10 }], nextCursor: null };
    if (args.afterId) return { files: [{ ...file, path: "notes/second.md", storedId: 2, hunkCount: 0, ranges: [] }], nextCursor: null };
    return { files: [file], nextCursor: 1 };
  });
  const onCommand = vi.fn().mockResolvedValue(true);
  const onOpenWorkspaceFile = vi.fn();
  render(<RemoteExecutionInsight sessionId="native-session" message={message} execution={{ ...execution, response: { ...execution.response, relatedFiles: [...execution.response.relatedFiles], verification: [...execution.response.verification] } }} transport={{ invoke, listen: vi.fn() }} onCommand={onCommand} enabled onOpenWorkspaceFile={onOpenWorkspaceFile} />);
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onCommand).toHaveBeenCalledWith({ kind: "retry", taskId: "native-task" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onCommand).toHaveBeenCalledWith({ kind: "continue", taskId: "native-task" });
  expect(screen.getByText("Instructions used")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "notes/related.md" }));
  expect(onOpenWorkspaceFile).toHaveBeenCalledWith("notes/related.md");
  fireEvent.click(screen.getByRole("button", { name: /Open file changes/u }));
  await screen.findByRole("button", { name: /Modified notes\/Grüße.md/u });
  expect(invoke).toHaveBeenCalledWith("get_session_file_change_files", { sessionId: "native-session", messageId: "native-message", changeSetId: "native-set", limit: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Show all 3 line ranges" }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "notes/Grüße.md changed line ranges" })).getAllByRole("listitem")).toHaveLength(3));
  expect(invoke).toHaveBeenCalledWith("get_session_file_change_hunks", { sessionId: "native-session", messageId: "native-message", changeSetId: "native-set", fileId: 1, afterOrdinal: 1, limit: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Load more changed paths" }));
  await screen.findByRole("button", { name: /Modified notes\/second.md/u });
  expect(invoke).toHaveBeenCalledWith("get_session_file_change_files", { sessionId: "native-session", messageId: "native-message", changeSetId: "native-set", afterId: 1, limit: 100 });
  expect(screen.queryByRole("button", { name: "Load more changed paths" })).toBeNull();
});

it("shows a recoverable paging failure without accepting an overlapping native page", async () => {
  const invoke = vi.fn().mockResolvedValue({ files: [file], nextCursor: 1 });
  render(<RemoteExecutionInsight sessionId="native-session" message={message} execution={{ task: "Native task", status: "executed", fileChanges: changes }} transport={{ invoke, listen: vi.fn() }} onCommand={vi.fn()} enabled={false} onOpenWorkspaceFile={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open file changes/u }));
  await screen.findByRole("button", { name: "Load more changed paths" });
  fireEvent.click(screen.getByRole("button", { name: "Load more changed paths" }));
  await screen.findByText("Stored changed-file page did not advance.");
  expect(screen.getAllByRole("button", { name: /Modified notes\/Grüße.md/u })).toHaveLength(1);
});
