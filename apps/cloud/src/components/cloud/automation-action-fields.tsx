"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  changeMeasures,
  type AutomationAction,
} from "@/lib/cloud-automation-contract";
import { channelKindLabels, channelKinds } from "@/lib/cloud-release-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import type { CloudWorkflowStatus } from "@/lib/cloud-workflow-contract";
import { ChipToggle, VariableMenu } from "./automation-chips";
import { actionKinds } from "./automation-display";
import { ClientTargetSelect } from "./automation-client-fields";
import { GitActionFields, isGitAction } from "./automation-git-action-fields";
import { TemplateText } from "./automation-template-text";
import { priorityOptions } from "./issue-properties";
import type { AutomationOptions } from "./use-automation-options";

export function defaultAction(
  kind: AutomationAction["kind"],
  context: {
    statuses: CloudWorkflowStatus[];
    options: AutomationOptions;
    teamId: string;
  },
): AutomationAction {
  const model = context.options.models[0];
  switch (kind) {
    case "set_status":
      return { kind, statusId: context.statuses[0]?.id ?? "" };
    case "set_priority":
      return { kind, priority: "high" };
    case "assign":
      return { kind, assignee: "trigger_actor" };
    case "add_labels":
    case "remove_labels":
      return { kind, labelIds: [] };
    case "comment":
      return { kind, body: "" };
    case "create_issue":
      return {
        kind,
        title: "",
        description: "",
        statusId: null,
        priority: "none",
        assigneeId: null,
        labelIds: [],
        subIssue: false,
      };
    case "ask_agent":
      return {
        kind,
        prompt: "",
        providerId: model?.providerId ?? "",
        model: model?.model ?? "",
        postAnswer: true,
        applyProposals: false,
      };
    case "delegate":
      return {
        kind,
        profileId:
          context.options.profiles.find(
            (profile) => profile.teamId === context.teamId,
          )?.id ?? "",
        instructions: "",
        acceptanceCriteria: "",
      };
    case "send_webhook":
      return { kind, url: "", body: "" };
    case "git_comment":
      return { kind, body: "", identity: "owner" };
    case "git_review":
      return { kind, decision: "comment", body: "", identity: "owner" };
    case "git_merge":
      return { kind, method: "squash", identity: "owner" };
    case "git_update_branch":
    case "git_retarget":
      return { kind, identity: "owner" };
    case "start_client_session":
      return {
        kind,
        instanceId: context.options.clients[0]?.instanceId ?? "",
        workspace: context.options.clients[0]?.workspace ?? "",
        title: "{{issue.identifier}} {{issue.title}}",
        prompt:
          "Implement {{issue.identifier}}: {{issue.title}}\n\n{{issue.url}}\n\nWork on a new branch, run the checks and summarize what changed.",
        goal: true,
      };
    case "write_release_posts":
      return {
        kind,
        channelKinds: [],
        providerId: model?.providerId ?? "",
        model: model?.model ?? "",
        instructions: "",
        measure: "issues",
        minimumChanges: 0,
      };
    case "prepare_release":
      return {
        kind,
        productId: context.options.products[0]?.id ?? "",
        version: "{{date}}",
        name: "",
        providerId: model?.providerId ?? null,
        model: model?.model ?? "",
        instructions: "",
      };
    case "write_project_updates":
      return {
        kind,
        projectIds: [],
        providerId: model?.providerId ?? "",
        model: model?.model ?? "",
      };
    case "run_automation":
      return { kind, automationId: "" };
    case "set_automation_enabled":
      return { kind, automationId: "", enabled: false };
  }
}

function ModelSelect({
  label,
  options,
  providerId,
  model,
  onChange,
}: {
  label: string;
  options: AutomationOptions;
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      value={`${providerId}/${model}`}
      onChange={(event) => {
        const [nextProviderId, ...nextModel] = event.target.value.split("/");
        onChange(nextProviderId ?? "", nextModel.join("/"));
      }}
    >
      {!options.models.some(
        (option) => option.providerId === providerId && option.model === model,
      ) && <option value={`${providerId}/${model}`} />}
      {options.models.map((option) => (
        <option
          key={`${option.providerId}/${option.model}`}
          value={`${option.providerId}/${option.model}`}
        >
          {option.label}
        </option>
      ))}
    </Select>
  );
}

export function ActionCard({
  action,
  index,
  count,
  workspace,
  statuses,
  labels,
  options,
  teamId,
  variables,
  automations,
  hasIssue,
  hasPullRequest,
  onChange,
  onMove,
  onRemove,
}: {
  action: AutomationAction;
  index: number;
  count: number;
  workspace: CloudWorkspace;
  statuses: CloudWorkflowStatus[];
  labels: CloudLabel[];
  options: AutomationOptions;
  teamId: string;
  variables: string[];
  automations: { id: string; name: string }[];
  hasIssue: boolean;
  hasPullRequest: boolean;
  onChange: (action: AutomationAction) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const kind = actionKinds.find((entry) => entry.kind === action.kind)!;
  const Icon = kind.icon;
  const members = workspace.members.map((member) => (
    <option key={member.id} value={member.id}>
      {member.name}
    </option>
  ));
  const statusOptions = statuses.map((status) => (
    <option key={status.id} value={status.id}>
      {status.name}
    </option>
  ));
  const priorities = priorityOptions.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
  return (
    <section className="cloud-automation-action" aria-label={kind.label}>
      <header>
        <span className="cloud-automation-step">{index + 1}</span>
        <Icon size={14} aria-hidden="true" />
        <h4>{kind.label}</h4>
        <span className="cloud-automation-spacer" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${kind.label.toLowerCase()}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </header>
      {action.kind === "set_status" && (
        <Select
          aria-label="Status"
          value={action.statusId}
          onChange={(event) =>
            onChange({ ...action, statusId: event.target.value })
          }
        >
          {statusOptions}
        </Select>
      )}
      {action.kind === "set_priority" && (
        <Select
          aria-label="Priority"
          value={action.priority}
          onChange={(event) =>
            onChange({
              ...action,
              priority: event.target.value as typeof action.priority,
            })
          }
        >
          {priorities}
        </Select>
      )}
      {action.kind === "assign" && (
        <Select
          aria-label="Assignee"
          value={action.assignee}
          onChange={(event) =>
            onChange({ ...action, assignee: event.target.value })
          }
        >
          <option value="trigger_actor">Whoever triggered it</option>
          <option value="unassigned">Unassigned</option>
          {members}
        </Select>
      )}
      {(action.kind === "add_labels" || action.kind === "remove_labels") && (
        <ChipToggle
          label="Labels"
          options={labels.map((label) => ({
            value: label.id,
            label: label.name,
          }))}
          selected={action.labelIds}
          onChange={(labelIds) => onChange({ ...action, labelIds })}
        />
      )}
      {action.kind === "comment" && (
        <TemplateText
          label="Comment"
          value={action.body}
          variables={variables}
          maxLength={20_000}
          onChange={(body) => onChange({ ...action, body })}
        />
      )}
      {action.kind === "create_issue" && (
        <>
          <div className="cloud-automation-template">
            <div className="cloud-automation-template-heading">
              <Label>Title</Label>
              <VariableMenu
                variables={variables}
                onInsert={(variable) =>
                  onChange({ ...action, title: `${action.title}${variable}` })
                }
              />
            </div>
            <Input
              aria-label="Title"
              maxLength={300}
              value={action.title}
              onChange={(event) =>
                onChange({ ...action, title: event.target.value })
              }
            />
          </div>
          <TemplateText
            label="Description"
            value={action.description}
            variables={variables}
            rows={3}
            maxLength={20_000}
            onChange={(description) => onChange({ ...action, description })}
          />
          <div className="cloud-automation-row">
            <Select
              aria-label="Status"
              value={action.statusId ?? ""}
              onChange={(event) =>
                onChange({ ...action, statusId: event.target.value || null })
              }
            >
              <option value="">Default status</option>
              {statusOptions}
            </Select>
            <Select
              aria-label="Priority"
              value={action.priority}
              onChange={(event) =>
                onChange({
                  ...action,
                  priority: event.target.value as typeof action.priority,
                })
              }
            >
              {priorities}
            </Select>
            <Select
              aria-label="Assignee"
              value={action.assigneeId ?? ""}
              onChange={(event) =>
                onChange({ ...action, assigneeId: event.target.value || null })
              }
            >
              <option value="">Unassigned</option>
              {members}
            </Select>
          </div>
          {labels.length > 0 && (
            <ChipToggle
              label="Labels"
              options={labels.map((label) => ({
                value: label.id,
                label: label.name,
              }))}
              selected={action.labelIds}
              onChange={(labelIds) => onChange({ ...action, labelIds })}
            />
          )}
          {hasIssue && (
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={action.subIssue}
                onChange={(event) =>
                  onChange({ ...action, subIssue: event.target.checked })
                }
              />
              Create as sub-issue
            </Label>
          )}
        </>
      )}
      {action.kind === "ask_agent" && (
        <>
          <TemplateText
            label="Prompt"
            value={action.prompt}
            variables={variables}
            maxLength={8_000}
            onChange={(prompt) => onChange({ ...action, prompt })}
          />
          <ModelSelect
            label="Model"
            options={options}
            providerId={action.providerId}
            model={action.model}
            onChange={(providerId, model) =>
              onChange({ ...action, providerId, model })
            }
          />
          <div className="cloud-automation-row">
            {hasIssue && (
              <Label className="cloud-automation-check">
                <input
                  type="checkbox"
                  checked={action.postAnswer}
                  onChange={(event) =>
                    onChange({ ...action, postAnswer: event.target.checked })
                  }
                />
                Post answer as comment
              </Label>
            )}
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={action.applyProposals}
                onChange={(event) =>
                  onChange({ ...action, applyProposals: event.target.checked })
                }
              />
              Apply proposals automatically
            </Label>
          </div>
        </>
      )}
      {action.kind === "delegate" && (
        <>
          <Select
            aria-label="Execution profile"
            value={action.profileId}
            onChange={(event) =>
              onChange({ ...action, profileId: event.target.value })
            }
          >
            {!action.profileId && <option value="" />}
            {options.profiles
              .filter((profile) => profile.teamId === teamId)
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
          </Select>
          {hasPullRequest && (
            <>
              <TemplateText
                label="Instructions"
                value={action.instructions}
                variables={variables}
                rows={3}
                maxLength={20_000}
                onChange={(instructions) =>
                  onChange({ ...action, instructions })
                }
              />
              <TemplateText
                label="Done when"
                value={action.acceptanceCriteria}
                variables={variables}
                rows={2}
                maxLength={20_000}
                onChange={(acceptanceCriteria) =>
                  onChange({ ...action, acceptanceCriteria })
                }
              />
            </>
          )}
        </>
      )}
      {action.kind === "prepare_release" && (
        <>
          <div className="cloud-automation-row">
            <Select
              aria-label="Product"
              value={action.productId}
              onChange={(event) =>
                onChange({ ...action, productId: event.target.value })
              }
            >
              {!action.productId && <option value="" />}
              {options.products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Version"
              placeholder="Version, such as {{date}}"
              maxLength={40}
              value={action.version}
              onChange={(event) =>
                onChange({ ...action, version: event.target.value })
              }
            />
          </div>
          <Select
            aria-label="Writer"
            value={
              action.providerId ? `${action.providerId}/${action.model}` : ""
            }
            onChange={(event) => {
              const [providerId, ...model] = event.target.value.split("/");
              onChange({
                ...action,
                providerId: providerId || null,
                model: model.join("/"),
              });
            }}
          >
            <option value="">Create an empty release</option>
            {options.models.map((option) => (
              <option
                key={`${option.providerId}/${option.model}`}
                value={`${option.providerId}/${option.model}`}
              >
                Agent writes it · {option.label}
              </option>
            ))}
          </Select>
          {action.providerId && (
            <TemplateText
              label="Instructions"
              value={action.instructions}
              variables={variables}
              rows={2}
              maxLength={2_000}
              onChange={(instructions) => onChange({ ...action, instructions })}
            />
          )}
        </>
      )}
      {action.kind === "write_release_posts" && (
        <>
          <ChipToggle
            label="Channels"
            options={channelKinds.map((kind) => ({
              value: kind,
              label: channelKindLabels[kind],
            }))}
            selected={action.channelKinds}
            onChange={(selected) =>
              onChange({
                ...action,
                channelKinds: selected as typeof action.channelKinds,
              })
            }
          />
          <ModelSelect
            label="Writer"
            options={options}
            providerId={action.providerId}
            model={action.model}
            onChange={(providerId, model) =>
              onChange({ ...action, providerId, model })
            }
          />
          <div className="cloud-automation-template">
            <Label htmlFor={`automation-minimum-${index}`}>
              Minimum changes since the last post
            </Label>
            <div className="cloud-automation-row">
              <Input
                id={`automation-minimum-${index}`}
                type="number"
                min={0}
                max={10_000}
                required
                value={action.minimumChanges}
                onChange={(event) =>
                  onChange({
                    ...action,
                    minimumChanges: Math.max(
                      0,
                      Math.floor(Number(event.target.value) || 0),
                    ),
                  })
                }
              />
              <Select
                aria-label="Measure"
                value={action.measure}
                onChange={(event) =>
                  onChange({
                    ...action,
                    measure: event.target.value as typeof action.measure,
                  })
                }
              >
                {changeMeasures.map((measure) => (
                  <option key={measure} value={measure}>
                    {measure === "points" ? "Estimate points" : "Issues"}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <TemplateText
            label="Instructions"
            value={action.instructions}
            variables={variables}
            rows={2}
            maxLength={2_000}
            onChange={(instructions) => onChange({ ...action, instructions })}
          />
        </>
      )}
      {action.kind === "start_client_session" && (
        <>
          <ClientTargetSelect
            action={action}
            clients={options.clients}
            loaded={options.loaded}
            onChange={onChange}
          />
          <TemplateText
            label="Session title"
            value={action.title}
            variables={variables}
            rows={1}
            maxLength={120}
            onChange={(title) => onChange({ ...action, title })}
          />
          <TemplateText
            label="Prompt"
            value={action.prompt}
            variables={variables}
            rows={4}
            maxLength={8_000}
            onChange={(prompt) => onChange({ ...action, prompt })}
          />
          <Label className="cloud-automation-check">
            <input
              type="checkbox"
              checked={action.goal}
              onChange={(event) =>
                onChange({ ...action, goal: event.target.checked })
              }
            />
            Goal mode
          </Label>
        </>
      )}
      {isGitAction(action) && (
        <GitActionFields
          action={action}
          variables={variables}
          onChange={onChange}
        />
      )}
      {action.kind === "write_project_updates" && (
        <>
          <ChipToggle
            label="Projects"
            options={workspace.projects
              .filter(
                (project) =>
                  project.teamId === teamId &&
                  !["completed", "canceled"].includes(project.status),
              )
              .map((project) => ({ value: project.id, label: project.name }))}
            selected={action.projectIds}
            onChange={(projectIds) => onChange({ ...action, projectIds })}
          />
          <ModelSelect
            label="Writer"
            options={options}
            providerId={action.providerId}
            model={action.model}
            onChange={(providerId, model) =>
              onChange({ ...action, providerId, model })
            }
          />
        </>
      )}
      {(action.kind === "run_automation" ||
        action.kind === "set_automation_enabled") && (
        <div className="cloud-automation-row">
          {action.kind === "set_automation_enabled" && (
            <Select
              aria-label="Change"
              value={action.enabled ? "on" : "off"}
              onChange={(event) =>
                onChange({ ...action, enabled: event.target.value === "on" })
              }
            >
              <option value="off">Pause</option>
              <option value="on">Turn on</option>
            </Select>
          )}
          <Select
            aria-label="Automation"
            value={action.automationId}
            onChange={(event) =>
              onChange({ ...action, automationId: event.target.value })
            }
          >
            {!action.automationId && (
              <option value="">Choose automation</option>
            )}
            {automations.map((automation) => (
              <option key={automation.id} value={automation.id}>
                {automation.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {action.kind === "send_webhook" && (
        <>
          <Input
            type="url"
            aria-label="Webhook URL"
            placeholder="https://"
            maxLength={2_000}
            value={action.url}
            onChange={(event) =>
              onChange({ ...action, url: event.target.value })
            }
          />
          <TemplateText
            label="Body"
            value={action.body}
            variables={variables}
            rows={3}
            maxLength={20_000}
            onChange={(body) => onChange({ ...action, body })}
          />
        </>
      )}
    </section>
  );
}

export function actionIncomplete(action: AutomationAction): boolean {
  switch (action.kind) {
    case "set_status":
      return !action.statusId;
    case "add_labels":
    case "remove_labels":
      return !action.labelIds.length;
    case "comment":
    case "git_comment":
      return !action.body.trim();
    case "git_review":
      return action.decision !== "approve" && !action.body.trim();
    case "create_issue":
      return !action.title.trim();
    case "ask_agent":
      return !action.prompt.trim() || !action.providerId || !action.model;
    case "write_release_posts":
    case "write_project_updates":
      return !action.providerId || !action.model;
    case "run_automation":
    case "set_automation_enabled":
      return !action.automationId;
    case "delegate":
      return !action.profileId;
    case "send_webhook":
      return !action.url.startsWith("https://");
    case "start_client_session":
      return (
        !action.instanceId || !action.title.trim() || !action.prompt.trim()
      );
    case "prepare_release":
      return !action.productId || !action.version.trim();
    default:
      return false;
  }
}
