import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z.string().min(1).max(4_000);
const stageNames = [
  "discovery",
  "startSnapshots",
  "finishSnapshots",
  "renameAnalysis",
  "lineAnalysis",
  "persistence",
] as const;
const stage = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("complete") }),
  z.strictObject({
    state: z.literal("failed"),
    code: z.string().max(100),
    message: z.string().max(4_000),
  }),
]);

export const taskChangedLineRangeSchema = z.strictObject({
  oldStart: count,
  oldLines: count,
  newStart: count,
  newLines: count,
});

export const taskFileChangeSchema = z.strictObject({
  path,
  oldPath: path.optional(),
  operation: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "type-changed",
  ]),
  entryType: z.enum(["text", "binary", "gitlink", "symlink", "mode"]),
  repositoryPath: path.optional(),
  oldMode: z.string().min(1).max(12),
  newMode: z.string().min(1).max(12),
  oldObjectId: z.string().max(128).optional(),
  newObjectId: z.string().max(128).optional(),
  oldCommit: z.string().max(128).optional(),
  newCommit: z.string().max(128).optional(),
  lineAnalysis: z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("complete"),
      additions: count,
      deletions: count,
    }),
    z.strictObject({
      state: z.literal("not-applicable"),
      reason: z.enum(["binary", "gitlink", "symlink", "mode-only"]),
    }),
    z.strictObject({
      state: z.literal("failed"),
      code: z.literal("git-failed"),
      message: z.string().max(4_000),
    }),
  ]),
  ranges: z.array(taskChangedLineRangeSchema).optional(),
  hunkCount: count.optional(),
  storedId: count.optional(),
});

export const taskFileChangesSchema = z.strictObject({
  files: z.array(taskFileChangeSchema),
  changeSetId: z.string().min(1).max(128).optional(),
  totalFiles: count,
  additions: count,
  deletions: count,
  binaryFiles: count,
  gitlinkFiles: count,
  symlinkFiles: count,
  modeOnlyFiles: count,
  failedFiles: count,
  status: z.enum(["complete", "partial", "failed"]),
  completeness: z.strictObject({
    discovery: stage,
    startSnapshots: stage,
    finishSnapshots: stage,
    renameAnalysis: stage,
    lineAnalysis: stage,
    persistence: stage,
  }),
  attribution: z.literal("workspace-observed"),
  repositoryCount: count,
  issues: z.array(
    z.strictObject({
      stage: z.enum(stageNames),
      code: z.string().max(100),
      message: z.string().max(4_000),
      repositoryPath: path.optional(),
    }),
  ),
});

export const taskFileChangePageSchema = z.strictObject({
  files: z.array(taskFileChangeSchema).max(100),
  nextCursor: count.nullable().optional(),
});
export const taskFileChangeHunkPageSchema = z.strictObject({
  ranges: z.array(taskChangedLineRangeSchema).max(100),
  nextCursor: count.nullable().optional(),
});

export type TaskExecutionChangedLineRange = z.infer<
  typeof taskChangedLineRangeSchema
>;
export type TaskExecutionFileChange = z.infer<typeof taskFileChangeSchema>;
export type TaskExecutionFileChanges = z.infer<typeof taskFileChangesSchema>;
export type TaskExecutionFileChangeOperation =
  TaskExecutionFileChange["operation"];
export type TaskExecutionFileEntryType = TaskExecutionFileChange["entryType"];
export type TaskExecutionFileLineAnalysis =
  TaskExecutionFileChange["lineAnalysis"];
export type TaskExecutionFileChangeCompleteness =
  TaskExecutionFileChanges["completeness"];
export type TaskExecutionFileChangeStage = z.infer<typeof stage>;
export type TaskExecutionFileChangeIssue =
  TaskExecutionFileChanges["issues"][number];
export type TaskFileChangePage = z.infer<typeof taskFileChangePageSchema>;
export type TaskFileChangeHunkPage = z.infer<
  typeof taskFileChangeHunkPageSchema
>;

export interface TaskFileChangeReader {
  getFiles: (
    changeSetId: string,
    afterId?: number,
  ) => Promise<TaskFileChangePage>;
  getHunks: (
    changeSetId: string,
    fileId: number,
    afterOrdinal?: number,
  ) => Promise<TaskFileChangeHunkPage>;
}
