"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  automationOutcomes,
  scheduleFrequencies,
  type AutomationTrigger,
} from "@/lib/cloud-automation-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import type { CloudProduct } from "@/lib/cloud-release-contract";
import type { CloudWorkflowStatus } from "@/lib/cloud-workflow-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import { pullRequestStages } from "@/lib/git-automation";
import { GitTriggerFields } from "./automation-git-trigger-fields";
import { ChipToggle } from "./automation-chips";
import { priorityOptions } from "./issue-properties";
import {
  automationOutcomeLabels,
  triggerKinds,
  weekdays,
} from "./automation-display";
import { pullRequestStageLabels } from "./pull-request-state";

const frequencyLabels = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
} as const;

export function defaultTrigger(
  kind: AutomationTrigger["kind"],
): AutomationTrigger {
  switch (kind) {
    case "status_changed":
      return { kind, statusIds: [] };
    case "priority_changed":
      return { kind, priorities: [] };
    case "label_added":
      return { kind, labelIds: [] };
    case "comment_created":
      return { kind, contains: "" };
    case "pull_request_changed":
      return { kind, stages: [] };
    case "git_event":
      return {
        kind,
        events: ["pull_request_opened"],
        repositoryIds: [],
        branches: [],
        headBranches: [],
        actors: [],
        contains: "",
      };
    case "release_created":
      return { kind, productIds: [] };
    case "automation_finished":
      return { kind, automationIds: [], outcomes: ["failed"] };
    case "schedule":
      return {
        kind,
        frequency: "weekdays",
        time: "09:00",
        weekday: 1,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        forEachIssue: false,
      };
    default:
      return { kind } as AutomationTrigger;
  }
}

export function TriggerFields({
  trigger,
  statuses,
  labels,
  products,
  repositories,
  automations,
  onChange,
}: {
  trigger: AutomationTrigger;
  automations: { id: string; name: string }[];
  statuses: CloudWorkflowStatus[];
  labels: CloudLabel[];
  products: CloudProduct[];
  repositories: GitRepositoryOption[];
  onChange: (trigger: AutomationTrigger) => void;
}) {
  const groups = [...new Set(triggerKinds.map((entry) => entry.group))];
  return (
    <div className="cloud-automation-fields">
      <Select
        aria-label="Trigger"
        value={trigger.kind}
        onChange={(event) =>
          onChange(
            defaultTrigger(event.target.value as AutomationTrigger["kind"]),
          )
        }
      >
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {triggerKinds
              .filter(
                (entry) =>
                  entry.group === group &&
                  (trigger.kind === entry.kind ||
                    (entry.kind === "pull_request_changed" ||
                    entry.kind === "git_event"
                      ? repositories.length > 0
                      : entry.kind === "automation_finished"
                        ? automations.length > 0
                        : entry.kind !== "release_created" ||
                          products.length > 0)),
              )
              .map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      {trigger.kind === "status_changed" && (
        <ChipToggle
          label="To status"
          options={statuses.map((status) => ({
            value: status.id,
            label: status.name,
          }))}
          selected={trigger.statusIds}
          onChange={(statusIds) => onChange({ ...trigger, statusIds })}
        />
      )}
      {trigger.kind === "priority_changed" && (
        <ChipToggle
          label="To priority"
          options={priorityOptions}
          selected={trigger.priorities}
          onChange={(priorities) =>
            onChange({
              ...trigger,
              priorities: priorities as typeof trigger.priorities,
            })
          }
        />
      )}
      {trigger.kind === "label_added" && (
        <ChipToggle
          label="Labels"
          options={labels.map((label) => ({
            value: label.id,
            label: label.name,
          }))}
          selected={trigger.labelIds}
          onChange={(labelIds) => onChange({ ...trigger, labelIds })}
        />
      )}
      {trigger.kind === "comment_created" && (
        <Input
          aria-label="Comment contains"
          placeholder="Contains text, such as @agent"
          maxLength={200}
          value={trigger.contains}
          onChange={(event) =>
            onChange({ ...trigger, contains: event.target.value })
          }
        />
      )}
      {trigger.kind === "pull_request_changed" && (
        <ChipToggle
          label="Stages"
          options={pullRequestStages.map((stage) => ({
            value: stage,
            label: pullRequestStageLabels[stage],
          }))}
          selected={trigger.stages}
          onChange={(stages) =>
            onChange({ ...trigger, stages: stages as typeof trigger.stages })
          }
        />
      )}
      {trigger.kind === "git_event" && (
        <GitTriggerFields
          trigger={trigger}
          repositories={repositories}
          onChange={onChange}
        />
      )}
      {trigger.kind === "release_created" && products.length > 1 && (
        <ChipToggle
          label="Products"
          options={products.map((product) => ({
            value: product.id,
            label: product.name,
          }))}
          selected={trigger.productIds}
          onChange={(productIds) => onChange({ ...trigger, productIds })}
        />
      )}
      {trigger.kind === "automation_finished" && (
        <>
          <ChipToggle
            label="Automations"
            options={automations.map((automation) => ({
              value: automation.id,
              label: automation.name,
            }))}
            selected={trigger.automationIds}
            onChange={(automationIds) =>
              onChange({ ...trigger, automationIds })
            }
          />
          <ChipToggle
            label="When it"
            options={automationOutcomes.map((outcome) => ({
              value: outcome,
              label: automationOutcomeLabels[outcome],
            }))}
            selected={trigger.outcomes}
            onChange={(outcomes) =>
              onChange({
                ...trigger,
                outcomes: outcomes as typeof trigger.outcomes,
              })
            }
          />
        </>
      )}
      {trigger.kind === "schedule" && (
        <>
          <div className="cloud-automation-row">
            <Select
              aria-label="Frequency"
              value={trigger.frequency}
              onChange={(event) =>
                onChange({
                  ...trigger,
                  frequency: event.target
                    .value as (typeof scheduleFrequencies)[number],
                })
              }
            >
              {scheduleFrequencies.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {frequencyLabels[frequency]}
                </option>
              ))}
            </Select>
            {trigger.frequency === "weekly" && (
              <Select
                aria-label="Weekday"
                value={trigger.weekday}
                onChange={(event) =>
                  onChange({ ...trigger, weekday: Number(event.target.value) })
                }
              >
                {weekdays.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </Select>
            )}
            <Input
              type="time"
              aria-label="Time"
              value={trigger.time}
              required
              onChange={(event) =>
                onChange({ ...trigger, time: event.target.value })
              }
            />
            <Input
              aria-label="Time zone"
              value={trigger.timeZone}
              required
              maxLength={64}
              onChange={(event) =>
                onChange({ ...trigger, timeZone: event.target.value })
              }
            />
          </div>
          <Label className="cloud-automation-check">
            <input
              type="checkbox"
              checked={trigger.forEachIssue}
              onChange={(event) =>
                onChange({ ...trigger, forEachIssue: event.target.checked })
              }
            />
            Run for each matching issue
          </Label>
        </>
      )}
    </div>
  );
}
