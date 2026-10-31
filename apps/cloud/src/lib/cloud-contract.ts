import { z } from "zod";
import type { CloudOrganization } from "./cloud-administration-contract";
import type { CloudTeamWorkflow } from "./cloud-workflow-contract";

export const cloudId = z.uuid();
export const revision = z.number().int().min(1).max(2_147_483_646);
export const issueStatusReferenceSchema = z.strictObject({
  id: cloudId,
  revision,
});
export const cloudRoles = ["owner", "admin", "member", "viewer"] as const;
export type CloudRole = (typeof cloudRoles)[number];
export const issueStates = [
  "backlog",
  "ready",
  "active",
  "blocked",
  "review",
  "complete",
  "canceled",
] as const;
export const issuePriorities = [
  "none",
  "urgent",
  "high",
  "normal",
  "low",
] as const;
const name = z.string().trim().min(1).max(120);
export const estimateCardSchema = z.strictObject({
  label: z.string().trim().min(1).max(16),
  points: z.number().min(0).max(100_000).nullable(),
});
export const estimateScaleSchema = z
  .array(estimateCardSchema)
  .min(2)
  .max(30)
  .superRefine((cards, ctx) => {
    if (
      new Set(cards.map((card) => card.label.toLowerCase())).size !==
      cards.length
    )
      ctx.addIssue({ code: "custom", message: "Card labels must be unique." });
    if (!cards.some((card) => card.points !== null))
      ctx.addIssue({
        code: "custom",
        message: "Include at least one card with a point value.",
      });
  });
export const defaultEstimateScale: EstimateCard[] = [
  ...[0, 1, 2, 3, 5, 8, 13, 21].map((points) => ({
    label: String(points),
    points,
  })),
  { label: "?", points: null },
  { label: "Abstain", points: null },
];
export const teamInputSchema = z.strictObject({
  name,
  key: z
    .string()
    .trim()
    .regex(
      /^[A-Z][A-Z0-9]{1,9}$/,
      "Use 2–10 uppercase letters or numbers, starting with a letter.",
    ),
  visibility: z.enum(["organization", "private"]),
  estimateScale: estimateScaleSchema,
});
export const projectStatuses = [
  "backlog",
  "planned",
  "active",
  "paused",
  "completed",
  "canceled",
] as const;
const projectDatesValid = (value: {
  startsOn?: string | null;
  targetOn?: string | null;
}) => !value.startsOn || !value.targetOn || value.targetOn >= value.startsOn;
const projectDatesIssue = {
  path: ["targetOn"],
  message: "Target date must not precede the start date.",
};
export const projectInputSchema = z
  .strictObject({
    teamId: cloudId,
    name,
    description: z.string().max(20_000).default(""),
    status: z.enum(projectStatuses).optional(),
    leadId: cloudId.nullable().optional(),
    startsOn: z.iso.date().nullable().optional(),
    targetOn: z.iso.date().nullable().optional(),
  })
  .refine(projectDatesValid, projectDatesIssue);
export const projectUpdateSchema = z
  .strictObject({
    revision,
    name,
    description: z.string().max(20_000),
    status: z.enum(projectStatuses),
    leadId: cloudId.nullable(),
    startsOn: z.iso.date().nullable(),
    targetOn: z.iso.date().nullable(),
  })
  .refine(projectDatesValid, projectDatesIssue);
const date = z.iso.date();
export const cycleInputSchema = z
  .strictObject({
    teamId: cloudId,
    name,
    startsOn: date,
    endsOn: date,
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid time zone."),
    capacity: z.number().min(0).max(1_000_000).nullable(),
  })
  .refine((value) => value.endsOn > value.startsOn, {
    path: ["endsOn"],
    message: "End date must follow start date.",
  });
export const issueInputSchema = z.strictObject({
  teamId: cloudId,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(30_000).default(""),
  acceptanceCriteria: z.string().max(20_000).default(""),
  status: issueStatusReferenceSchema.nullable().default(null),
  priority: z.enum(issuePriorities).default("none"),
  projectId: cloudId.nullable().default(null),
  cycleId: cloudId.nullable().default(null),
  assigneeId: cloudId.nullable().default(null),
  estimate: z.string().max(16).nullable().default(null),
  dueOn: date.nullable().default(null),
});
export const issueUpdateSchema = issueInputSchema
  .omit({ teamId: true })
  .extend({
    revision,
    archived: z.boolean(),
    status: issueStatusReferenceSchema,
  });
export const scaleUpdateSchema = z.strictObject({
  revision,
  estimateScale: estimateScaleSchema,
});
export const pokerInputSchema = z.strictObject({
  issueId: cloudId,
  issueRevision: revision,
});
export const pokerVoteSchema = z.strictObject({
  revision,
  card: z.string().min(1).max(16),
});
export const pokerCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("takeover"), revision }),
  z.strictObject({ kind: z.literal("reveal"), revision }),
  z.strictObject({ kind: z.literal("restart"), revision }),
  z.strictObject({ kind: z.literal("close"), revision }),
  z.strictObject({
    kind: z.literal("decide"),
    revision,
    issueRevision: revision,
    card: z.string().min(1).max(16),
    rationale: z.string().trim().max(4_000),
  }),
]);
export type EstimateCard = z.infer<typeof estimateCardSchema>;
export type TeamInput = z.infer<typeof teamInputSchema>;
export type IssueInput = z.infer<typeof issueInputSchema>;
export type IssueUpdate = z.infer<typeof issueUpdateSchema>;
export type CycleInput = z.infer<typeof cycleInputSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export type PokerCommand = z.infer<typeof pokerCommandSchema>;
export interface CloudActor {
  userId: string;
  organizationId: string;
  delegation?: {
    tokenHash: string;
    scope: "cloud:read" | "cloud:write" | "cloud:execute";
  };
}
export interface CloudTeam extends TeamInput {
  id: string;
  revision: number;
  scaleRevision: number;
}
export interface CloudProject {
  id: string;
  teamId: string;
  name: string;
  description: string;
  status: (typeof projectStatuses)[number];
  leadId: string | null;
  startsOn: string | null;
  targetOn: string | null;
  revision: number;
}
export interface CloudProjectProgress {
  projectId: string;
  total: number;
  started: number;
  completed: number;
  points: number;
  completedPoints: number;
}
export interface CloudCycle extends CycleInput {
  id: string;
  revision: number;
  status: "planned" | "active" | "closed";
}
export interface CloudIssue extends IssueInput {
  status: z.infer<typeof issueStatusReferenceSchema>;
  statusName: string;
  state: (typeof issueStates)[number];
  id: string;
  identifier: string;
  revision: number;
  archived: boolean;
  estimatePoints: number | null;
  updatedAt: string;
}
export type IssueSnapshot = Omit<CloudIssue, "status" | "statusName">;
export interface CloudIssueSummary extends Omit<
  CloudIssue,
  "description" | "acceptanceCriteria"
> {
  labels: { id: string; name: string; color: string }[];
  activeRun: { id: string; state: string } | null;
  createdAt: string;
}
export const issueSorts = ["updated", "created", "priority", "due"] as const;
export type IssueSort = (typeof issueSorts)[number];
export interface IssueFilters {
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  labelId?: string;
  statusId?: string;
  query?: string;
  archived?: boolean;
  offset?: number;
  states?: CloudIssue["state"][];
  assignedToActor?: boolean;
  assigneeId?: string;
  unassigned?: boolean;
  priority?: CloudIssue["priority"];
  unestimated?: boolean;
  noCycle?: boolean;
  sort?: IssueSort;
}
export interface CloudMember {
  id: string;
  name: string;
  role: CloudRole;
}
export interface CloudWorkspace {
  organization: CloudOrganization;
  actor: CloudMember;
  members: CloudMember[];
  teams: CloudTeam[];
  projects: CloudProject[];
  cycles: CloudCycle[];
  workflows: CloudTeamWorkflow[];
}
export interface PokerRound {
  id: string;
  issueId: string;
  facilitatorId: string;
  revision: number;
  generation: number;
  issueRevision: number;
  status: "voting" | "revealed" | "decided" | "closed";
  scale: EstimateCard[];
  scaleRevision: number;
  stale: boolean;
  votes: { userId: string; name: string; card: string | null }[];
  decision: string | null;
  rationale: string | null;
}
