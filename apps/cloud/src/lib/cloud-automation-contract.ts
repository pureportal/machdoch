import { z } from "zod";
import { cloudId, issuePriorities, revision } from "./cloud-contract";
import { channelKinds } from "./cloud-release-contract";
import { pullRequestStages } from "./git-automation";
import {
  branchPatternSchema,
  gitEventKinds,
  isPullRequestEvent,
} from "./git-events";
import { gitMergeMethods, gitReviewDecisionInputs } from "./cloud-git-contract";
import { issueFilterConditionSchema } from "./issue-filter-model";
import { maximumPulseProjects } from "./cloud-pulse-contract";

export const automationOutcomes = ["succeeded", "failed", "skipped"] as const;
export type AutomationOutcome = (typeof automationOutcomes)[number];

export const scheduleFrequencies = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
] as const;
export type ScheduleFrequency = (typeof scheduleFrequencies)[number];

const idList = z.array(cloudId).max(50).default([]);
const template = (maximum: number) => z.string().max(maximum);

const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid time zone.");

export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue_created") }),
  z.strictObject({ kind: z.literal("status_changed"), statusIds: idList }),
  z.strictObject({
    kind: z.literal("priority_changed"),
    priorities: z.array(z.enum(issuePriorities)).max(5).default([]),
  }),
  z.strictObject({ kind: z.literal("assignee_changed") }),
  z.strictObject({ kind: z.literal("label_added"), labelIds: idList }),
  z.strictObject({
    kind: z.literal("comment_created"),
    contains: z.string().trim().max(200).default(""),
  }),
  z.strictObject({
    kind: z.literal("pull_request_changed"),
    stages: z.array(z.enum(pullRequestStages)).max(6).default([]),
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    frequency: z.enum(scheduleFrequencies),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM."),
    weekday: z.number().int().min(0).max(6).default(1),
    timeZone,
    forEachIssue: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("git_event"),
    events: z
      .array(z.enum(gitEventKinds))
      .min(1, "Choose at least one event.")
      .max(gitEventKinds.length),
    repositoryIds: idList,
    branches: z.array(branchPatternSchema).max(20).default([]),
    headBranches: z.array(branchPatternSchema).max(20).default([]),
    actors: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    contains: z.string().trim().max(200).default(""),
  }),
  z.strictObject({ kind: z.literal("release_created"), productIds: idList }),
  z.strictObject({
    kind: z.literal("automation_finished"),
    automationIds: idList,
    outcomes: z
      .array(z.enum(automationOutcomes))
      .min(1, "Choose at least one outcome.")
      .max(automationOutcomes.length)
      .default(["failed"]),
  }),
  z.strictObject({ kind: z.literal("webhook") }),
  z.strictObject({ kind: z.literal("manual") }),
]);
export type AutomationTrigger = z.output<typeof automationTriggerSchema>;
export type AutomationTriggerKind = AutomationTrigger["kind"];

export const issueEventTriggerKinds = [
  "issue_created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "label_added",
  "comment_created",
  "pull_request_changed",
] as const satisfies readonly AutomationTriggerKind[];
export type IssueEventTriggerKind = (typeof issueEventTriggerKinds)[number];

export const gitIdentities = ["owner", "organization"] as const;
export type GitIdentity = (typeof gitIdentities)[number];
const gitIdentity = z.enum(gitIdentities).default("owner");

export const changeMeasures = ["issues", "points"] as const;
export type ChangeMeasure = (typeof changeMeasures)[number];

export const automationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set_status"), statusId: cloudId }),
  z.strictObject({
    kind: z.literal("set_priority"),
    priority: z.enum(issuePriorities),
  }),
  z.strictObject({
    kind: z.literal("assign"),
    assignee: z.union([z.enum(["trigger_actor", "unassigned"]), cloudId]),
  }),
  z.strictObject({
    kind: z.literal("add_labels"),
    labelIds: z.array(cloudId).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal("remove_labels"),
    labelIds: z.array(cloudId).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal("comment"),
    body: template(20_000).trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("create_issue"),
    title: template(300).trim().min(1),
    description: template(20_000).default(""),
    statusId: cloudId.nullable().default(null),
    priority: z.enum(issuePriorities).default("none"),
    assigneeId: cloudId.nullable().default(null),
    labelIds: z.array(cloudId).max(20).default([]),
    subIssue: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("ask_agent"),
    prompt: template(8_000).trim().min(1),
    providerId: cloudId,
    model: z.string().trim().min(1).max(200),
    postAnswer: z.boolean().default(true),
    applyProposals: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("delegate"),
    profileId: cloudId,
    instructions: template(20_000).default(""),
    acceptanceCriteria: template(20_000).default(""),
  }),
  z.strictObject({
    kind: z.literal("prepare_release"),
    productId: cloudId,
    version: template(40).trim().min(1),
    name: template(120).default(""),
    providerId: cloudId.nullable().default(null),
    model: z.string().trim().max(200).default(""),
    instructions: template(2_000).default(""),
  }),
  z.strictObject({
    kind: z.literal("write_release_posts"),
    channelKinds: z
      .array(z.enum(channelKinds))
      .max(channelKinds.length)
      .default([]),
    providerId: cloudId,
    model: z.string().trim().min(1).max(200),
    instructions: template(2_000).default(""),
    measure: z.enum(changeMeasures).default("issues"),
    minimumChanges: z.number().int().min(0).max(10_000).default(0),
  }),
  z.strictObject({
    kind: z.literal("start_client_session"),
    instanceId: z.string().trim().min(1).max(240),
    workspace: z.string().trim().min(1).max(12_000),
    title: template(120).trim().min(1),
    prompt: template(8_000).trim().min(1),
    goal: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("git_comment"),
    body: template(20_000).trim().min(1),
    identity: gitIdentity,
  }),
  z.strictObject({
    kind: z.literal("git_review"),
    decision: z.enum(gitReviewDecisionInputs),
    body: template(20_000).default(""),
    identity: gitIdentity,
  }),
  z.strictObject({
    kind: z.literal("git_merge"),
    method: z.enum(gitMergeMethods).default("squash"),
    identity: gitIdentity,
  }),
  z.strictObject({
    kind: z.literal("git_update_branch"),
    identity: gitIdentity,
  }),
  z.strictObject({ kind: z.literal("git_retarget"), identity: gitIdentity }),
  z.strictObject({
    kind: z.literal("write_project_updates"),
    projectIds: z.array(cloudId).max(maximumPulseProjects).default([]),
    providerId: cloudId,
    model: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ kind: z.literal("run_automation"), automationId: cloudId }),
  z.strictObject({
    kind: z.literal("set_automation_enabled"),
    automationId: cloudId,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("send_webhook"),
    url: z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(2_000),
    body: template(20_000).default(""),
  }),
]);
export type AutomationAction = z.output<typeof automationActionSchema>;
export type AutomationActionKind = AutomationAction["kind"];

export const issueActionKinds = [
  "set_status",
  "set_priority",
  "assign",
  "add_labels",
  "remove_labels",
  "comment",
] as const satisfies readonly AutomationActionKind[];

export function delegateHasTarget(trigger: AutomationTrigger): boolean {
  return trigger.kind === "git_event"
    ? triggerHasPullRequest(trigger)
    : triggerHasIssue(trigger) || triggerHasPullRequest(trigger);
}

export const pullRequestActionKinds = [
  "git_comment",
  "git_review",
  "git_merge",
  "git_update_branch",
  "git_retarget",
] as const satisfies readonly AutomationActionKind[];

export function actionNeedsPullRequest(action: AutomationAction): boolean {
  return (pullRequestActionKinds as readonly string[]).includes(action.kind);
}

export function triggerHasPullRequest(trigger: AutomationTrigger): boolean {
  if (trigger.kind === "pull_request_changed") return true;
  return (
    trigger.kind === "git_event" &&
    trigger.events.length > 0 &&
    trigger.events.every(isPullRequestEvent)
  );
}

export function triggerHasIssue(trigger: AutomationTrigger): boolean {
  if (trigger.kind === "schedule") return trigger.forEachIssue;
  return (
    trigger.kind !== "release_created" && trigger.kind !== "automation_finished"
  );
}

export function actionNeedsIssue(action: AutomationAction): boolean {
  return (
    (issueActionKinds as readonly string[]).includes(action.kind) ||
    (action.kind === "create_issue" && action.subIssue)
  );
}

export function actionNeedsManualIssue(action: AutomationAction): boolean {
  return actionNeedsIssue(action) || action.kind === "delegate";
}

export function actionHasRelease(
  input: Pick<AutomationInput, "trigger" | "actions">,
  index: number,
): boolean {
  return (
    input.trigger.kind === "release_created" ||
    input.actions
      .slice(0, index)
      .some((action) => action.kind === "prepare_release")
  );
}

export const automationInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    teamId: cloudId,
    trigger: automationTriggerSchema,
    conditions: z.array(issueFilterConditionSchema).max(10).default([]),
    actions: z.array(automationActionSchema).min(1).max(10),
    dailyLimit: z.number().int().min(1).max(1000).default(100),
  })
  .superRefine((input, context) => {
    const hasIssue = triggerHasIssue(input.trigger);
    if (
      !hasIssue &&
      (input.trigger.kind === "release_created" ||
        input.trigger.kind === "automation_finished")
    )
      input.conditions.forEach((_, index) =>
        context.addIssue({
          code: "custom",
          path: ["conditions", index],
          message: "This trigger has no issue to filter.",
        }),
      );
    const hasPullRequest = triggerHasPullRequest(input.trigger);
    input.actions.forEach((action, index) => {
      if (!hasPullRequest && actionNeedsPullRequest(action))
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message:
            "This action needs a pull request. Trigger on pull request events only.",
        });
      if (action.kind === "delegate" && !delegateHasTarget(input.trigger))
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message:
            "This action needs an issue, or a trigger with only pull request events.",
        });
      if (!hasIssue && actionNeedsIssue(action))
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message:
            input.trigger.kind === "schedule"
              ? "This action needs an issue. Run the schedule for each matching issue."
              : "This action needs an issue.",
        });
      if (action.kind !== "write_release_posts") return;
      if (!actionHasRelease(input, index))
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message:
            "Writing posts needs a release. Trigger on new releases or prepare one first.",
        });
      if (
        input.actions
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.kind === "prepare_release" && earlier.providerId,
          )
      )
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message:
            "The release is already written by Agent. Prepare it without a writer.",
        });
    });
  });
export type AutomationInput = z.output<typeof automationInputSchema>;
export const automationUpdateSchema = z.strictObject({
  revision,
  automation: automationInputSchema,
});
export const automationStateSchema = z.strictObject({
  revision,
  enabled: z.boolean(),
});
export const automationRunInputSchema = z.strictObject({
  issueId: cloudId.nullable().default(null),
});

export const automationRunStates = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type AutomationRunState = (typeof automationRunStates)[number];

export interface AutomationStep {
  kind: AutomationActionKind;
  state: "succeeded" | "failed" | "skipped";
  detail: string;
  link: string | null;
}

export interface CloudAutomation extends AutomationInput {
  id: string;
  ownerId: string;
  ownerName: string;
  enabled: boolean;
  revision: number;
  error: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runsToday: number;
  webhookConfigured: boolean;
  createdAt: string;
}

export interface CloudAutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  trigger: string;
  state: AutomationRunState;
  issueId: string | null;
  issueIdentifier: string | null;
  actorName: string | null;
  steps: AutomationStep[];
  chatId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AutomationSecret {
  id: string;
  webhookUrl: string | null;
}

export const maximumWebhookPayloadBytes = 64 * 1024;
