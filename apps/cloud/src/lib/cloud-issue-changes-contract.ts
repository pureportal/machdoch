import { z } from "zod";
import {
  cloudId,
  issuePriorities,
  issueStates,
  issueStatusReferenceSchema,
  revision,
} from "./cloud-contract";

const textChanges = ["title", "description", "acceptanceCriteria"] as const;

export const issueChangeSetSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(30_000),
    acceptanceCriteria: z.string().max(20_000),
    status: issueStatusReferenceSchema,
    statusCategory: z.enum(issueStates),
    priority: z.enum(issuePriorities),
    assigneeId: cloudId.nullable(),
    projectId: cloudId.nullable(),
    cycleId: cloudId.nullable(),
    estimate: z.string().max(16).nullable(),
    dueOn: z.iso.date().nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, "Choose a change.")
  .refine(
    (changes) => !(changes.status && changes.statusCategory),
    "Choose either a status or a status category.",
  );

export const issueChangesSchema = z
  .strictObject({
    issues: z
      .array(z.strictObject({ id: cloudId, revision: revision.optional() }))
      .min(1)
      .max(100)
      .refine(
        (issues) => new Set(issues.map((issue) => issue.id)).size === issues.length,
        "Choose each issue once.",
      ),
    changes: issueChangeSetSchema,
  })
  .superRefine((value, context) => {
    if (!textChanges.some((name) => value.changes[name] !== undefined)) return;
    if (value.issues.length !== 1 || value.issues[0]!.revision === undefined)
      context.addIssue({
        code: "custom",
        message: "Text edits apply to one issue at its current revision.",
      });
  });

export type IssueChangeSet = z.infer<typeof issueChangeSetSchema>;
export type IssueChanges = z.infer<typeof issueChangesSchema>;
export interface IssueChangesResult extends Record<string, unknown> {
  updated: { id: string; revision: number }[];
}
