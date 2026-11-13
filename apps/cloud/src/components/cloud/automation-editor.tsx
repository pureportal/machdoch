"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  AutomationAction,
  AutomationInput,
  AutomationSecret,
  CloudAutomation,
} from "@/lib/cloud-automation-contract";
import {
  actionHasRelease,
  actionNeedsIssue,
  actionNeedsPullRequest,
  delegateHasTarget,
  pullRequestActionKinds,
  triggerHasIssue,
  triggerHasPullRequest,
} from "@/lib/cloud-automation-contract";
import { isPullRequestEvent } from "@/lib/git-events";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { automationVariableNames } from "@/lib/automation-text";
import type {
  IssueFilterCondition,
  IssueFilterField,
} from "@/lib/issue-filter-model";
import { createCommandSender } from "./api-client";
import {
  ActionCard,
  actionIncomplete,
  defaultAction,
} from "./automation-action-fields";
import { actionKinds } from "./automation-display";
import { TriggerFields } from "./automation-trigger-fields";
import { IssueFilterButton, IssueFilterChips } from "./issue-filters";
import { filterFieldDefinitions } from "./issue-filter-fields";
import { PropertyMenu } from "./property-menu";
import type { AutomationOptions } from "./use-automation-options";

function availableVariables(
  input: AutomationInput,
  index: number,
  hasIssue: boolean,
): string[] {
  const kind = input.trigger.kind;
  const agentBefore = input.actions
    .slice(0, index)
    .some((action) => action.kind === "ask_agent");
  const git = input.trigger.kind === "git_event" ? input.trigger.events : [];
  const gitHas = (...kinds: string[]) =>
    git.some((event) => kinds.includes(event));
  return automationVariableNames.filter((name) => {
    if (name.startsWith("issue.")) return hasIssue;
    if (name === "comment.body")
      return kind === "comment_created" || gitHas("comment_created");
    if (name.startsWith("comment.")) return gitHas("comment_created");
    if (name === "pullRequest.stage") return kind === "pull_request_changed";
    if (name === "pullRequest.title" || name === "pullRequest.url")
      return kind === "pull_request_changed" || git.some(isPullRequestEvent);
    if (name.startsWith("pullRequest.")) return git.some(isPullRequestEvent);
    if (
      [
        "event.kind",
        "repository.name",
        "repository.url",
        "branch",
        "sender",
      ].includes(name)
    )
      return git.length > 0;
    if (name === "tag") return gitHas("tag_created");
    if (name.startsWith("push.")) return gitHas("push");
    if (name.startsWith("review."))
      return gitHas(
        "review_approved",
        "review_changes_requested",
        "review_commented",
        "review_dismissed",
      );
    if (name.startsWith("parent.")) return gitHas("stack_base_merged");
    if (name === "payload") return kind === "webhook";
    if (name.startsWith("release.")) return actionHasRelease(input, index);
    if (name === "agent.answer") return agentBefore;
    if (name === "actor.name")
      return ![
        "schedule",
        "webhook",
        "pull_request_changed",
        "release_created",
      ].includes(kind);
    return true;
  });
}

function useConditionState(
  conditions: IssueFilterCondition[],
  onChange: (conditions: IssueFilterCondition[]) => void,
  definitions: ReturnType<typeof filterFieldDefinitions>,
) {
  const condition = (field: IssueFilterField) =>
    conditions.find((entry) => entry.field === field) ?? null;
  const setCondition = (
    field: IssueFilterField,
    next: { negated: boolean; values: string[] } | null,
  ) =>
    onChange([
      ...conditions.filter((entry) => entry.field !== field),
      ...(next?.values.length ? [{ field, ...next }] : []),
    ]);
  return {
    conditions,
    teamId: null,
    fields: definitions.map((definition) => ({
      key: definition.field,
      label: definition.label,
      icon: definition.icon,
      options: definition.options,
      multiple: true,
    })),
    selected: (key: string) => condition(key as IssueFilterField)?.values ?? [],
    toggle: (key: string, value: string) => {
      const field = key as IssueFilterField;
      const current = condition(field);
      const values = current?.values ?? [];
      const nextValues = values.includes(value)
        ? values.filter((entry) => entry !== value)
        : [...values, value];
      setCondition(field, {
        negated: current?.negated ?? false,
        values: nextValues,
      });
    },
    setCondition,
  };
}

export function AutomationEditor({
  workspace,
  options,
  initial,
  automation,
  onClose,
  onSaved,
}: {
  workspace: CloudWorkspace;
  options: AutomationOptions;
  initial: AutomationInput;
  automation?: CloudAutomation;
  onClose: () => void;
  onSaved: (secret: AutomationSecret) => Promise<void>;
}) {
  const [input, setInput] = useState(initial);
  const sender = useRef(createCommandSender());
  const update = (patch: Partial<AutomationInput>) =>
    setInput((current) => ({ ...current, ...patch }));
  const statuses =
    workspace.workflows
      .find((workflow) => workflow.teamId === input.teamId)
      ?.statuses.filter((status) => !status.archived) ?? [];
  const labels = options.labels.filter(
    (label) => label.teamId === input.teamId,
  );
  const definitions = filterFieldDefinitions(
    workspace,
    labels,
    input.teamId,
  ).filter((definition) => definition.field !== "creator");
  const conditionState = useConditionState(
    input.conditions,
    (conditions) => update({ conditions }),
    definitions,
  );
  const hasIssue = triggerHasIssue(input.trigger);
  const hasPullRequest = triggerHasPullRequest(input.trigger);
  const addable = actionKinds.filter(
    (entry) =>
      (hasIssue || !entry.issue) &&
      (hasPullRequest ||
        !(pullRequestActionKinds as readonly string[]).includes(entry.kind)) &&
      (entry.kind !== "send_webhook" ||
        holderCan(workspace.actor, "settings.manage")) &&
      (entry.kind !== "start_client_session" ||
        holderCan(workspace.actor, "clients.manage")) &&
      (entry.kind !== "ask_agent" || options.models.length > 0) &&
      (entry.kind !== "delegate" ||
        (delegateHasTarget(input.trigger) &&
          options.profiles.some(
            (profile) => profile.teamId === input.teamId,
          ))) &&
      (entry.kind !== "prepare_release" || options.products.length > 0) &&
      (entry.kind !== "write_release_posts" ||
        (options.models.length > 0 &&
          actionHasRelease(input, input.actions.length))),
  );
  const invalid =
    !input.name.trim() ||
    !input.actions.length ||
    input.actions.some(actionIncomplete) ||
    (!hasIssue && input.actions.some(actionNeedsIssue)) ||
    (!hasPullRequest && input.actions.some(actionNeedsPullRequest)) ||
    (!delegateHasTarget(input.trigger) &&
      input.actions.some((action) => action.kind === "delegate"));
  const setAction = (index: number, action: AutomationAction) =>
    update({
      actions: input.actions.map((entry, position) =>
        position === index ? action : entry,
      ),
    });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={automation ? "Edit automation" : "New automation"}
      submitLabel={automation ? "Save" : "Create automation"}
      submitDisabled={invalid}
      onSubmit={async () => {
        const secret = await sender.current<AutomationSecret>(
          automation ? `automations/${automation.id}` : "automations",
          automation
            ? { revision: automation.revision, automation: input }
            : input,
          automation ? "PATCH" : "POST",
        );
        await onSaved(secret);
      }}
    >
      <div className="cloud-automation-editor">
        <div className="cloud-automation-row">
          <Field label="Name" htmlFor="automation-name">
            <Input
              id="automation-name"
              required
              maxLength={120}
              value={input.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          {!automation && workspace.teams.length > 1 && (
            <Field label="Team" htmlFor="automation-team">
              <Select
                id="automation-team"
                value={input.teamId}
                onChange={(event) =>
                  update({
                    teamId: event.target.value,
                    conditions: [],
                    actions: [],
                    trigger:
                      input.trigger.kind === "status_changed"
                        ? { ...input.trigger, statusIds: [] }
                        : input.trigger.kind === "label_added"
                          ? { ...input.trigger, labelIds: [] }
                          : input.trigger,
                  })
                }
              >
                {workspace.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <section className="cloud-automation-section" aria-label="When">
          <h3>When</h3>
          <TriggerFields
            trigger={input.trigger}
            statuses={statuses}
            labels={labels}
            products={options.products}
            repositories={options.repositories}
            onChange={(trigger) =>
              update({
                trigger,
                ...(trigger.kind === "release_created"
                  ? { conditions: [] }
                  : {}),
              })
            }
          />
        </section>
        {hasIssue && (
          <section className="cloud-automation-section" aria-label="If">
            <h3>If</h3>
            {input.conditions.length ? (
              <IssueFilterChips
                state={conditionState}
                definitions={definitions}
                workspace={workspace}
                onClear={() => update({ conditions: [] })}
              >
                <IssueFilterButton
                  fields={conditionState.fields}
                  selected={conditionState.selected}
                  onToggle={conditionState.toggle}
                />
              </IssueFilterChips>
            ) : (
              <IssueFilterButton
                fields={conditionState.fields}
                selected={conditionState.selected}
                onToggle={conditionState.toggle}
              />
            )}
          </section>
        )}
        <section className="cloud-automation-section" aria-label="Then">
          <h3>Then</h3>
          {input.actions.map((action, index) => (
            <ActionCard
              key={index}
              action={action}
              index={index}
              count={input.actions.length}
              workspace={workspace}
              statuses={statuses}
              labels={labels}
              options={options}
              teamId={input.teamId}
              variables={availableVariables(input, index, hasIssue)}
              hasIssue={hasIssue}
              hasPullRequest={hasPullRequest}
              onChange={(next) => setAction(index, next)}
              onMove={(offset) => {
                const actions = [...input.actions];
                const [moved] = actions.splice(index, 1);
                actions.splice(index + offset, 0, moved!);
                update({ actions });
              }}
              onRemove={() =>
                update({
                  actions: input.actions.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            />
          ))}
          {input.actions.length < 10 && (
            <PropertyMenu
              label="Add action"
              options={addable.map((entry) => {
                const Icon = entry.icon;
                return {
                  value: entry.kind,
                  label: entry.label,
                  group: entry.group,
                  icon: <Icon size={14} aria-hidden="true" />,
                };
              })}
              onSelect={(kind) =>
                update({
                  actions: [
                    ...input.actions,
                    defaultAction(kind as AutomationAction["kind"], {
                      statuses,
                      options,
                      teamId: input.teamId,
                    }),
                  ],
                })
              }
            >
              <Button type="button" variant="outline" size="sm">
                <Plus />
                Add action
              </Button>
            </PropertyMenu>
          )}
        </section>
        <Field label="Runs per day" htmlFor="automation-limit">
          <Input
            id="automation-limit"
            type="number"
            min={1}
            max={1000}
            required
            className="cloud-automation-limit"
            value={input.dailyLimit}
            onChange={(event) =>
              update({ dailyLimit: Number(event.target.value) || 1 })
            }
          />
        </Field>
      </div>
    </FormDialog>
  );
}
