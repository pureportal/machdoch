import { z } from "zod";
import { cloudId, issueStates, revision } from "./cloud-contract";

export const workflowStatusSchema = z.strictObject({
  id: cloudId.transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(60),
  category: z.enum(issueStates),
  archived: z.boolean(),
});
export const workflowDefinitionSchema = z
  .strictObject({
    revision,
    defaultStatusId: cloudId.transform((value) => value.toLowerCase()),
    statuses: z.array(workflowStatusSchema).min(1).max(100),
  })
  .superRefine((input, ctx) => {
    if (
      new Set(input.statuses.map((status) => status.id.toLowerCase())).size !==
      input.statuses.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "Status identifiers must be unique.",
      });
    if (
      new Set(input.statuses.map((status) => status.name.toLowerCase()))
        .size !== input.statuses.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "Status names must be unique.",
      });
    const initial = input.statuses.find(
      (status) =>
        status.id.toLowerCase() === input.defaultStatusId.toLowerCase(),
    );
    if (
      !initial ||
      initial.archived ||
      ["complete", "canceled"].includes(initial.category)
    )
      ctx.addIssue({
        code: "custom",
        path: ["defaultStatusId"],
        message: "Choose an active, unfinished status for new issues.",
      });
  });
export const workflowUpdateSchema = z.strictObject({
  definition: workflowDefinitionSchema,
  impactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowUpdate = z.infer<typeof workflowUpdateSchema>;
export interface CloudWorkflowStatus extends z.infer<
  typeof workflowStatusSchema
> {
  revision: number;
}
export interface CloudTeamWorkflow {
  teamId: string;
  revision: number;
  defaultStatusId: string;
  statuses: CloudWorkflowStatus[];
}
export interface WorkflowImpact {
  digest: string;
  changedIssues: number;
  pausedSchedules: number;
  changedTasks: number;
}
