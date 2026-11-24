import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  WorkspaceChangeEvents,
  WorkspaceEntryDeletion,
  WorkspaceEntryTransfer,
  WorkspaceEntryTransferMode,
  WorkspaceFileRange,
  WorkspaceFileSearch,
  WorkspaceGitBlame,
  WorkspaceGitBranchList,
  WorkspaceGitCallLog,
  WorkspaceGitComparison,
  WorkspaceGitConflictVersions,
  WorkspaceGitFileHistory,
  WorkspaceGitFileRevision,
  WorkspaceGitUndoPreview,
  WorkspacePullRequestChecks,
  WorkspaceTextReplaceResult,
  WorkspaceTextSearch,
  WorkspaceTextSearchOptions,
} from "@machdoch/fleet-protocol/workspace-contract";
import { listMcpServers, searchMachdochCloudIssues } from "../runtime";
import {
  createCloudIssueDirectory,
  type CloudIssueDirectory,
} from "./workspace-cloud-issues";
import {
  getRemoteWorkspacePlatform,
  invokeWorkspaceTools,
} from "./workspace-platform";
import {
  loadPreviewWorkspaceGitBlame,
  loadPreviewWorkspaceGitBranchList,
  loadPreviewWorkspaceGitComparison,
  loadPreviewWorkspaceGitConflict,
  loadPreviewWorkspaceGitFileHistory,
  loadPreviewWorkspaceGitUndo,
  loadPreviewWorkspacePullRequestChecks,
  PREVIEW_MCP_SERVERS,
} from "./workspace-preview-git-reads";
import {
  copyPreviewWorkspaceEntries,
  deletePreviewWorkspaceEntries,
  readPreviewWorkspaceFileRange,
  replacePreviewWorkspaceText,
  searchPreviewWorkspaceFiles,
  searchPreviewWorkspaceText,
  uploadPreviewWorkspaceFile,
} from "./workspace-preview-runtime";

const FILE_UPLOAD_CHUNK_BYTES = 768 * 1024;

const hostAvailable = (): boolean =>
  isTauri() || getRemoteWorkspacePlatform() !== null;

const requireRoot = (root: string, message: string): string => {
  const trimmed = root.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
};

const call = async <T>(
  command: string,
  args: Record<string, unknown>,
  preview: () => T,
): Promise<T> => {
  if (!hostAvailable()) return preview();
  try {
    return await invokeWorkspaceTools<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

const repositoryRequest = (
  workspaceRoot: string,
  repositoryRoot: string,
): { workspaceRoot: string; repositoryRoot: string } => ({
  workspaceRoot: requireRoot(workspaceRoot, "Select a workspace first."),
  repositoryRoot: requireRoot(repositoryRoot, "Select a Git repository first."),
});

export const watchWorkspaceChanges = (workspaceRoot: string): Promise<number> =>
  call("watch_workspace", { workspaceRoot }, () => 0);

export const unwatchWorkspaceChanges = (workspaceRoot: string): Promise<void> =>
  call("unwatch_workspace", { workspaceRoot }, () => undefined);

export const readWorkspaceChanges = (
  workspaceRoot: string,
  after: number,
): Promise<WorkspaceChangeEvents> =>
  call("read_workspace_changes", { workspaceRoot, after }, () => ({
    cursor: after,
    events: [],
    watching: false,
  }));

export const listWorkspaceGitBranches = (
  workspaceRoot: string,
  repositoryRoot: string,
): Promise<WorkspaceGitBranchList> =>
  call(
    "list_workspace_git_branches",
    { request: repositoryRequest(workspaceRoot, repositoryRoot) },
    () => loadPreviewWorkspaceGitBranchList(workspaceRoot, repositoryRoot),
  );

export const loadWorkspaceGitUndo = (
  workspaceRoot: string,
  repositoryRoot: string,
): Promise<WorkspaceGitUndoPreview | null> =>
  call(
    "get_workspace_git_undo",
    { request: repositoryRequest(workspaceRoot, repositoryRoot) },
    () => loadPreviewWorkspaceGitUndo(workspaceRoot, repositoryRoot),
  );

export const loadWorkspaceGitFileHistory = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): Promise<WorkspaceGitFileHistory> =>
  call(
    "get_workspace_git_file_history",
    {
      request: {
        ...repositoryRequest(workspaceRoot, repositoryRoot),
        relativePath,
      },
    },
    () =>
      loadPreviewWorkspaceGitFileHistory(
        workspaceRoot,
        repositoryRoot,
        relativePath,
      ),
  );

export const loadWorkspaceGitBlame = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
  revision?: string,
): Promise<WorkspaceGitBlame> =>
  call(
    "get_workspace_git_blame",
    {
      request: {
        ...repositoryRequest(workspaceRoot, repositoryRoot),
        relativePath,
        ...(revision ? { revision } : {}),
      },
    },
    () =>
      loadPreviewWorkspaceGitBlame(workspaceRoot, repositoryRoot, relativePath),
  );

export const loadWorkspaceGitFileRevision = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
  revision?: string,
): Promise<WorkspaceGitFileRevision> =>
  call(
    "get_workspace_git_file_revision",
    {
      request: {
        ...repositoryRequest(workspaceRoot, repositoryRoot),
        relativePath,
        ...(revision ? { revision } : {}),
      },
    },
    () => ({
      relativePath,
      revision: revision ?? "HEAD",
      content: null,
      binary: false,
    }),
  );

export const compareWorkspaceGitRevisions = (
  workspaceRoot: string,
  repositoryRoot: string,
  base: string,
  head: string,
): Promise<WorkspaceGitComparison> =>
  call(
    "compare_workspace_git_revisions",
    {
      request: {
        ...repositoryRequest(workspaceRoot, repositoryRoot),
        base,
        head,
      },
    },
    () =>
      loadPreviewWorkspaceGitComparison(
        workspaceRoot,
        repositoryRoot,
        base,
        head,
      ),
  );

export const loadWorkspaceGitConflict = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): Promise<WorkspaceGitConflictVersions> =>
  call(
    "get_workspace_git_conflict",
    {
      request: {
        ...repositoryRequest(workspaceRoot, repositoryRoot),
        relativePath,
      },
    },
    () => loadPreviewWorkspaceGitConflict(relativePath),
  );

export const loadWorkspacePullRequestChecks = (
  workspaceRoot: string,
  repositoryRoot: string,
  number: number,
): Promise<WorkspacePullRequestChecks> =>
  call(
    "get_workspace_pull_request_checks",
    {
      request: { ...repositoryRequest(workspaceRoot, repositoryRoot), number },
    },
    () =>
      loadPreviewWorkspacePullRequestChecks(
        workspaceRoot,
        repositoryRoot,
        number,
      ),
  );

export const loadWorkspaceGitCallLog = (
  workspaceRoot: string,
): Promise<WorkspaceGitCallLog> =>
  call("get_workspace_git_call_log", { workspaceRoot }, () => ({
    enabled: false,
    calls: [],
  }));

export const generateWorkspaceGitCommitMessage = async (
  workspaceRoot: string,
  repositoryRoot: string,
): Promise<string> => {
  const response = await call<{ message: string }>(
    "generate_workspace_git_commit_message",
    repositoryRequest(workspaceRoot, repositoryRoot),
    () => ({ message: "Update workspace files" }),
  );
  return response.message;
};

const cloudIssueDirectories = new Map<string, CloudIssueDirectory>();

export const getCloudIssueDirectory = (
  workspaceRoot: string,
): CloudIssueDirectory => {
  const existing = cloudIssueDirectories.get(workspaceRoot);
  if (existing) return existing;
  const directory = createCloudIssueDirectory({
    servers: async () =>
      hostAvailable()
        ? (await listMcpServers(workspaceRoot)).servers
        : PREVIEW_MCP_SERVERS,
    search: (query) => searchMachdochCloudIssues(workspaceRoot, query),
  });
  cloudIssueDirectories.set(workspaceRoot, directory);
  return directory;
};

export const searchWorkspaceFiles = (
  workspaceRoot: string,
  query: string,
  limit = 60,
): Promise<WorkspaceFileSearch> =>
  call(
    "search_workspace_files",
    { request: { workspaceRoot, query, limit } },
    () => searchPreviewWorkspaceFiles(query, limit),
  );

const searchFields = (options: WorkspaceTextSearchOptions) => ({
  query: options.query,
  regex: options.regex,
  caseSensitive: options.caseSensitive,
  wholeWord: options.wholeWord,
  ...(options.include?.trim() ? { include: options.include.trim() } : {}),
  ...(options.exclude?.trim() ? { exclude: options.exclude.trim() } : {}),
});

export const searchWorkspaceText = (
  workspaceRoot: string,
  options: WorkspaceTextSearchOptions,
  limit = 2000,
): Promise<WorkspaceTextSearch> =>
  call(
    "search_workspace_text",
    { request: { workspaceRoot, ...searchFields(options), limit } },
    () => searchPreviewWorkspaceText(options),
  );

export const replaceWorkspaceText = (
  workspaceRoot: string,
  options: WorkspaceTextSearchOptions,
  replacement: string,
  apply: boolean,
  files: { path: string; revision: string }[],
): Promise<WorkspaceTextReplaceResult> =>
  call(
    "replace_workspace_text",
    {
      request: {
        workspaceRoot,
        ...searchFields(options),
        replacement,
        apply,
        files,
      },
    },
    () => replacePreviewWorkspaceText(options, replacement, apply, files),
  );

export const deleteWorkspaceEntries = (
  workspaceRoot: string,
  relativePaths: string[],
  trash: boolean,
): Promise<WorkspaceEntryDeletion[]> =>
  call(
    "delete_workspace_entries",
    { request: { workspaceRoot, relativePaths, trash } },
    () => deletePreviewWorkspaceEntries(relativePaths),
  );

export const copyWorkspaceEntries = (
  workspaceRoot: string,
  sources: string[],
  targetDirectory: string,
  mode: WorkspaceEntryTransferMode,
): Promise<WorkspaceEntryTransfer[]> =>
  call(
    "copy_workspace_entries",
    { request: { workspaceRoot, sources, targetDirectory, mode } },
    () => copyPreviewWorkspaceEntries(sources, targetDirectory, mode),
  );

const encodeChunk = (bytes: Uint8Array): string => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

export const uploadWorkspaceFile = async (
  workspaceRoot: string,
  relativePath: string,
  file: Blob,
): Promise<void> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hostAvailable()) {
    uploadPreviewWorkspaceFile(relativePath, bytes);
    return;
  }
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + FILE_UPLOAD_CHUNK_BYTES);
    await invokeWorkspaceTools("upload_workspace_file", {
      request: {
        workspaceRoot,
        relativePath,
        chunkBase64: encodeChunk(chunk),
        append: offset > 0,
      },
    });
    offset += chunk.length;
  } while (offset < bytes.length);
};

export const readWorkspaceFileRange = (
  workspaceRoot: string,
  relativePath: string,
  offset: number,
  length: number,
): Promise<WorkspaceFileRange> =>
  call(
    "read_workspace_file_range",
    { request: { workspaceRoot, relativePath, offset, length } },
    () => readPreviewWorkspaceFileRange(relativePath, offset, length),
  );

export const canImportWorkspaceEntries = (): boolean =>
  isTauri() && getRemoteWorkspacePlatform() === null;

export const importWorkspaceEntries = async (
  workspaceRoot: string,
  sources: string[],
  targetDirectory: string,
): Promise<WorkspaceEntryTransfer[]> => {
  if (!canImportWorkspaceEntries()) {
    throw new Error(
      "Files from this computer can only be added to local workspaces.",
    );
  }
  return invoke<WorkspaceEntryTransfer[]>("import_workspace_entries", {
    request: { workspaceRoot, sources, targetDirectory },
  });
};

export const openWorkspaceToolWindow = async (
  workspaceRoot: string,
  tool: "files" | "terminal",
): Promise<void> => {
  if (isTauri() && !getRemoteWorkspacePlatform()) {
    await invoke("open_workspace_tool_window", { workspaceRoot, tool });
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("tool", tool);
  url.searchParams.set("workspace", workspaceRoot);
  window.open(url, `machdoch-${tool}`, "popup,width=1100,height=760");
};
