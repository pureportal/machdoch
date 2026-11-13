"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { ArrowRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  automationTemplates,
  type AutomationTemplate,
  type AutomationTemplateCategory,
} from "@/lib/automation-templates";
import type { AutomationInput } from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { actionKinds, triggerKinds } from "./automation-display";
import { AutomationDescribe } from "./automation-describe";
import { defaultTrigger } from "./automation-trigger-fields";
import type { AutomationOptions } from "./use-automation-options";

const categoryLabels: Record<AutomationTemplateCategory, string> = {
  agent: "Agent",
  workflow: "Workflow",
  chains: "Automations",
  integration: "Integrations",
};

export function blankAutomation(teamId: string): AutomationInput {
  return {
    name: "",
    teamId,
    trigger: defaultTrigger("issue_created"),
    conditions: [],
    actions: [],
    dailyLimit: 100,
  };
}

export function AutomationGallery({
  workspace,
  options,
  teamId,
  onTeamChange,
  onChoose,
}: {
  workspace: CloudWorkspace;
  options: AutomationOptions;
  teamId: string;
  onTeamChange: (teamId: string) => void;
  onChoose: (draft: AutomationInput) => void;
}) {
  const missing = (template: AutomationTemplate) =>
    template.requires.includes("agent") && !options.models.length
      ? "Needs an AI provider"
      : template.requires.includes("profile") &&
          !options.profiles.some((profile) => profile.teamId === teamId)
        ? "Needs an execution profile"
        : template.requires.includes("product") && !options.products.length
          ? "Needs a product"
          : template.requires.includes("client") &&
              !holderCan(workspace.actor, "clients.manage")
            ? "Only owners and administrators"
            : template.requires.includes("client") && !options.clients.length
              ? "Needs a connected client"
              : (template.trigger === "pull_request_changed" ||
                    template.trigger === "git_event") &&
                  !workspace.gitProviders.length
                ? "Needs a Git connection"
                : null;
  const build = (template: AutomationTemplate) =>
    template.build({
      teamId,
      statuses:
        workspace.workflows
          .find((workflow) => workflow.teamId === teamId)
          ?.statuses.filter((status) => !status.archived) ?? [],
      labels: options.labels.filter((label) => label.teamId === teamId),
      agent: options.models[0]
        ? {
            providerId: options.models[0].providerId,
            model: options.models[0].model,
          }
        : null,
      profileId:
        options.profiles.find((profile) => profile.teamId === teamId)?.id ??
        null,
      productId: options.products[0]?.id ?? null,
      client: options.clients[0] ?? null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  return (
    <div className="cloud-automation-gallery">
      <div className="cloud-automation-gallery-header">
        {workspace.teams.length > 1 && (
          <div
            className="cloud-automation-gallery-team"
            role="group"
            aria-label="Team"
          >
            {workspace.teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className="cloud-automation-chip"
                aria-pressed={team.id === teamId}
                onClick={() => onTeamChange(team.id)}
              >
                {team.name}
              </button>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => onChoose(blankAutomation(teamId))}
        >
          <Plus size={14} aria-hidden="true" />
          Start from scratch
        </Button>
      </div>
      {options.models.length > 0 && holderCan(workspace.actor, "ai.chat") && (
        <AutomationDescribe teamId={teamId} models={options.models} />
      )}
      {(Object.keys(categoryLabels) as AutomationTemplateCategory[]).map(
        (category) => (
          <section key={category} aria-label={categoryLabels[category]}>
            <h3>{categoryLabels[category]}</h3>
            <div className="cloud-automation-templates">
              {automationTemplates
                .filter((template) => template.category === category)
                .map((template) => {
                  const reason = missing(template);
                  const trigger = triggerKinds.find(
                    (entry) => entry.kind === template.trigger,
                  );
                  const Icon = trigger?.icon ?? Plus;
                  const actions = build(template).actions;
                  const action = actionKinds.find(
                    (entry) => entry.kind === actions[0]?.kind,
                  );
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className="cloud-automation-template-card"
                      disabled={!options.loaded || reason !== null}
                      onClick={() => onChoose(build(template))}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{template.name}</span>
                      {reason ? (
                        <small>{reason}</small>
                      ) : (
                        trigger &&
                        action && (
                          <small className="cloud-automation-template-flow">
                            {trigger.label}
                            <ArrowRight size={11} aria-hidden="true" />
                            {action.label}
                            {actions.length > 1 && ` +${actions.length - 1}`}
                          </small>
                        )
                      )}
                    </button>
                  );
                })}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
