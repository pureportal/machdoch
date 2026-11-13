import { z } from "zod";
import {
  automationActionSchema,
  automationInputSchema,
  automationTriggerSchema,
  type AutomationAction,
  type AutomationInput,
  type AutomationTrigger,
  type GitIdentity,
  type CloudAutomation,
} from "../../../lib/cloud-automation-contract";
import { automationVariableNames } from "../../../lib/automation-text";
import { holderCan } from "../../../lib/cloud-permissions";
import { channelKindLabels } from "../../../lib/cloud-release-contract";
import { issueFilterConditionSchema } from "../../../lib/issue-filter-model";
import { AgentLookupError } from "./agent-workspace";
import { agentTool, type AgentTool } from "./agent-tool";
import { field, pendingOutput, reference } from "./agent-proposal-helpers";
import type { CloudAgentSession } from "./agent-tools";

const automationReference = reference.describe("Automation name or ID.");
const automationLink = (id: string) => `/cloud/automations?automation=${id}`;

interface AutomationNames {
  statuses: Map<string, string>;
  labels: Map<string, string>;
  members: Map<string, string>;
  products: Map<string, string>;
}

async function automationNames(
  session: CloudAgentSession,
  teamId: string,
): Promise<AutomationNames> {
  const { actor, services, workspace } = session;
  const [labels, products] = await Promise.all([
    services.labels.list(actor, teamId),
    services.products.list(actor),
  ]);
  return {
    statuses: new Map(
      workspace.statuses(teamId).map((status) => [status.id, status.name]),
    ),
    labels: new Map(labels.map((label) => [label.id, label.name])),
    members: new Map(
      workspace.snapshot.members.map((member) => [member.id, member.name]),
    ),
    products: new Map(products.map((product) => [product.id, product.name])),
  };
}

function names(map: Map<string, string>, ids: string[]): string {
  return ids.map((id) => map.get(id) ?? "unavailable").join(" or ");
}

function gitActor(identity: GitIdentity): string {
  return identity === "owner"
    ? "as the owner"
    : "with the organization connection";
}

function describeTrigger(
  trigger: AutomationTrigger,
  lookup: AutomationNames,
): string {
  switch (trigger.kind) {
    case "issue_created":
      return "An issue is created";
    case "status_changed":
      return trigger.statusIds.length
        ? `Status changes to ${names(lookup.statuses, trigger.statusIds)}`
        : "Status changes";
    case "priority_changed":
      return trigger.priorities.length
        ? `Priority changes to ${trigger.priorities.join(" or ")}`
        : "Priority changes";
    case "assignee_changed":
      return "Assignee changes";
    case "label_added":
      return trigger.labelIds.length
        ? `${names(lookup.labels, trigger.labelIds)} is added`
        : "A label is added";
    case "comment_created":
      return trigger.contains
        ? `A comment mentions “${trigger.contains}”`
        : "A comment is added";
    case "pull_request_changed":
      return trigger.stages.length
        ? `A pull request is ${trigger.stages.join(" or ")}`
        : "A pull request changes";
    case "git_event": {
      const filters = [
        trigger.repositoryIds.length
          ? `in ${trigger.repositoryIds.length} ${trigger.repositoryIds.length === 1 ? "repository" : "repositories"}`
          : "",
        trigger.branches.length ? `on ${trigger.branches.join(", ")}` : "",
        trigger.headBranches.length
          ? `from ${trigger.headBranches.join(", ")}`
          : "",
        trigger.actors.length ? `by ${trigger.actors.join(" or ")}` : "",
        trigger.contains ? `mentioning “${trigger.contains}”` : "",
      ].filter(Boolean);
      return [
        `Repository event ${trigger.events.join(" or ")}`,
        ...filters,
      ].join(" ");
    }
    case "schedule":
      return `${trigger.frequency === "weekly" ? `Weekly on day ${trigger.weekday}` : trigger.frequency[0]!.toUpperCase() + trigger.frequency.slice(1)} at ${trigger.time} (${trigger.timeZone})${trigger.forEachIssue ? " for each matching issue" : ""}`;
    case "release_created":
      return trigger.productIds.length
        ? `A ${names(lookup.products, trigger.productIds)} release is created`
        : "A release is created";
    case "webhook":
      return "Its webhook is called";
    case "manual":
      return "Someone runs it";
  }
}

function describeAction(
  action: AutomationAction,
  lookup: AutomationNames,
): string {
  switch (action.kind) {
    case "set_status":
      return `Set status to ${names(lookup.statuses, [action.statusId])}`;
    case "set_priority":
      return `Set priority to ${action.priority}`;
    case "assign":
      return action.assignee === "trigger_actor"
        ? "Assign whoever triggered it"
        : action.assignee === "unassigned"
          ? "Unassign"
          : `Assign ${names(lookup.members, [action.assignee])}`;
    case "add_labels":
      return `Add ${names(lookup.labels, action.labelIds)}`;
    case "remove_labels":
      return `Remove ${names(lookup.labels, action.labelIds)}`;
    case "comment":
      return "Add a comment";
    case "create_issue":
      return `Create ${action.subIssue ? "sub-issue" : "issue"} “${action.title}”`;
    case "ask_agent":
      return `Ask Agent${action.applyProposals ? " and apply its proposals" : ""}`;
    case "delegate":
      return "Start an AI task";
    case "prepare_release":
      return `Prepare ${names(lookup.products, [action.productId])} release ${action.version}${action.providerId ? " written by Agent" : ""}`;
    case "write_release_posts": {
      const channels = action.channelKinds.length
        ? action.channelKinds
            .map((kind) => channelKindLabels[kind])
            .join(" and ")
        : "every channel";
      return action.minimumChanges
        ? `Agent writes the ${channels} posts once ${action.minimumChanges} ${action.measure === "points" ? "estimate points" : "issues"} shipped since the last post`
        : `Agent writes the ${channels} posts`;
    }
    case "send_webhook":
      return `Send a webhook to ${new URL(action.url).hostname}`;
    case "start_client_session":
      return `Start "${action.title}" on a client${action.goal ? " in goal mode" : ""}`;
    case "git_comment":
      return `Comment on the pull request ${gitActor(action.identity)}`;
    case "git_review":
      return `${action.decision === "approve" ? "Approve" : action.decision === "request_changes" ? "Request changes on" : "Review"} the pull request ${gitActor(action.identity)}`;
    case "git_merge":
      return `${action.method[0]!.toUpperCase()}${action.method.slice(1)} merge the pull request ${gitActor(action.identity)}`;
    case "git_update_branch":
      return `Update the pull request branch ${gitActor(action.identity)}`;
    case "git_retarget":
      return `Retarget the stacked pull request onto its merged base ${gitActor(action.identity)}`;
  }
}

function summary(automation: CloudAutomation, lookup: AutomationNames) {
  return {
    when: describeTrigger(automation.trigger, lookup),
    conditions: automation.conditions.length,
    then: automation.actions.map((action) => describeAction(action, lookup)),
  };
}

async function resolveAutomation(
  session: CloudAgentSession,
  value: string,
): Promise<CloudAutomation> {
  const key = value.trim().toLowerCase();
  const automations = await session.services.automations.list(session.actor);
  const match =
    automations.find((entry) => entry.id === value.trim()) ??
    automations.find((entry) => entry.name.toLowerCase() === key);
  if (!match)
    throw new AgentLookupError(
      `No automation matches ${value}. Automations: ${automations.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  return match;
}

export const automationTools: AgentTool[] = [
  agentTool({
    name: "list_automations",
    description:
      "List the workspace's automations with their trigger, actions, owner, state and recent activity.",
    schema: z.strictObject({
      team: reference.optional().describe("Team key or name."),
    }),
    async run(session, input) {
      const team = input.team ? session.workspace.team(input.team) : undefined;
      const automations = await session.services.automations.list(
        session.actor,
        { teamId: team?.id },
      );
      const lookups = new Map<string, AutomationNames>();
      const output = [];
      for (const automation of automations) {
        if (!lookups.has(automation.teamId))
          lookups.set(
            automation.teamId,
            await automationNames(session, automation.teamId),
          );
        output.push({
          name: automation.name,
          id: automation.id,
          link: automationLink(automation.id),
          team: session.workspace.teamById(automation.teamId)?.key ?? null,
          owner: automation.ownerName,
          ownedByYou: automation.ownerId === session.actor.userId,
          enabled: automation.enabled,
          ...summary(automation, lookups.get(automation.teamId)!),
          runsToday: automation.runsToday,
          lastRunAt: automation.lastRunAt,
          error: automation.error,
        });
      }
      return {
        output,
        label: `Listed ${automations.length} automation${automations.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "get_automation",
    description:
      "Read an automation's full definition with IDs, its revision and its 10 latest runs. Read it before proposing a change.",
    schema: z.strictObject({ automation: automationReference }),
    async run(session, input) {
      const automation = await resolveAutomation(session, input.automation);
      const [lookup, runs] = await Promise.all([
        automationNames(session, automation.teamId),
        session.services.automations.runs(session.actor, {
          automationId: automation.id,
        }),
      ]);
      return {
        output: {
          id: automation.id,
          link: automationLink(automation.id),
          team: session.workspace.teamById(automation.teamId)?.key ?? null,
          owner: automation.ownerName,
          ownedByYou: automation.ownerId === session.actor.userId,
          enabled: automation.enabled,
          error: automation.error,
          ...summary(automation, lookup),
          definition: {
            name: automation.name,
            trigger: automation.trigger,
            conditions: automation.conditions,
            actions: automation.actions,
            dailyLimit: automation.dailyLimit,
          },
          runs: runs.slice(0, 10).map((run) => ({
            state: run.state,
            trigger: run.trigger,
            issue: run.issueIdentifier,
            createdAt: run.createdAt.slice(0, 16),
            steps: run.steps.map((step) => `${step.state}: ${step.detail}`),
            error: run.error,
          })),
        },
        label: `Read automation ${automation.name}`,
      };
    },
  }),
  agentTool({
    name: "get_automation_options",
    description:
      "Read the IDs needed to build an automation for a team: statuses, labels, members, execution profiles, AI models, products with their channels and template variables. For start_client_session, take the client ID and workspace root from list_clients.",
    schema: z.strictObject({ team: reference.describe("Team key or name.") }),
    async run(session, input) {
      const { actor, services, workspace } = session;
      const team = workspace.team(input.team);
      const [labels, providers, profiles, products] = await Promise.all([
        services.labels.list(actor, team.id),
        services.providers.list(actor),
        services.profiles.list(actor),
        services.products.list(actor),
      ]);
      const channels = await Promise.all(
        products.map((product) => services.products.get(actor, product.id)),
      );
      return {
        output: {
          team: { id: team.id, key: team.key },
          statuses: workspace.statuses(team.id).map((status) => ({
            id: status.id,
            name: status.name,
            category: status.category,
          })),
          labels: labels
            .filter((label) => !label.archived)
            .map((label) => ({ id: label.id, name: label.name })),
          members: workspace.snapshot.members.map((member) => ({
            id: member.id,
            name: member.name,
          })),
          models: providers.providers.flatMap((provider) =>
            provider.models.map((model) => ({
              providerId: provider.id,
              model,
              provider: provider.name,
            })),
          ),
          conversationModel: session.model,
          executionProfiles: profiles
            .filter((profile) => profile.teamId === team.id && profile.enabled)
            .map((profile) => ({ id: profile.id, name: profile.name })),
          products: channels.map(({ product, channels: entries }) => ({
            id: product.id,
            name: product.name,
            channels: entries.map((channel) => ({
              name: channel.name,
              kind: channel.kind,
              enabled: channel.enabled,
            })),
          })),
          variables: automationVariableNames.map((name) => `{{${name}}}`),
          canSendWebhooks: holderCan(
            workspace.snapshot.actor,
            "settings.manage",
          ),
        },
        label: `Read automation options for ${team.key}`,
      };
    },
  }),
  agentTool({
    name: "propose_automation",
    description:
      "Propose a new automation, or a change to one you own (pass automation). Send the complete definition; read the current one with get_automation and the IDs with get_automation_options first. Nothing changes until the user confirms.",
    schema: z.strictObject({
      automation: automationReference
        .optional()
        .describe("Automation to change. Omit to create one."),
      team: reference
        .optional()
        .describe("Team key or name. Required for new automations."),
      name: z.string().trim().min(1).max(120),
      trigger: automationTriggerSchema,
      conditions: z
        .array(issueFilterConditionSchema)
        .max(10)
        .optional()
        .describe("Issue filters the triggering issue must match."),
      actions: z.array(automationActionSchema).min(1).max(10),
      dailyLimit: z.number().int().min(1).max(1000).optional(),
      enabled: z.boolean().optional(),
    }),
    async run(session, input) {
      const { workspace } = session;
      const current = input.automation
        ? await resolveAutomation(session, input.automation)
        : null;
      if (!current && !input.team)
        throw new AgentLookupError("Choose the team for the new automation.");
      const teamId = current?.teamId ?? workspace.team(input.team!).id;
      const parsed = automationInputSchema.safeParse({
        name: input.name,
        teamId,
        trigger: input.trigger,
        conditions: input.conditions ?? [],
        actions: input.actions,
        dailyLimit: input.dailyLimit ?? current?.dailyLimit ?? 100,
      });
      if (!parsed.success)
        throw new AgentLookupError(
          parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
            )
            .join(" "),
        );
      const automation: AutomationInput = parsed.data;
      await session.services.automations.validate(
        session.actor,
        automation,
        current?.id ?? null,
      );
      const lookup = await automationNames(session, teamId);
      const enabled = input.enabled ?? current?.enabled ?? true;
      return {
        output: pendingOutput,
        label: current
          ? `Proposed changes to ${current.name}`
          : `Proposed automation ${automation.name}`,
        proposal: {
          kind: "automation",
          title: current
            ? `Edit automation · ${automation.name}`
            : `New automation · ${automation.name}`,
          fields: [
            ...field("Team", workspace.teamById(teamId)?.key),
            ...field("When", describeTrigger(automation.trigger, lookup)),
            ...field(
              "If",
              automation.conditions.length
                ? `${automation.conditions.length} issue filter${automation.conditions.length === 1 ? "" : "s"}`
                : null,
            ),
            ...field(
              "Then",
              automation.actions
                .map(
                  (action, index) =>
                    `${index + 1}. ${describeAction(action, lookup)}`,
                )
                .join("\n"),
            ),
            ...field("Runs per day", String(automation.dailyLimit)),
            ...field("State", enabled ? null : "Paused"),
          ],
          automationId: current?.id ?? null,
          revision: current?.revision ?? null,
          automation,
          enabled,
        },
      };
    },
  }),
];
