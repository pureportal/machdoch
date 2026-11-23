import type {
  AutomationAction,
  AutomationInput,
  AutomationTrigger,
} from "./cloud-automation-contract";
import {
  loopGuardrailsSchema,
  type LoopConfig,
  type LoopContextSource,
  type LoopGuardrails,
  type LoopPlacement,
  type LoopSource,
  type LoopTemplateInstall,
} from "./cloud-loop-contract";

export interface LoopTemplateBuild {
  automation: AutomationInput;
  config: LoopConfig;
}

export interface LoopTemplate {
  id: string;
  name: string;
  needsDocument: boolean;
  placements: LoopPlacement[] | null;
  build: (install: LoopTemplateInstall) => LoopTemplateBuild;
}

function ask(
  install: LoopTemplateInstall,
  prompt: string,
  options: { postAnswer?: boolean; applyProposals?: boolean } = {},
): AutomationAction {
  return {
    kind: "ask_agent",
    prompt,
    providerId: install.providerId,
    model: install.model,
    postAnswer: options.postAnswer ?? false,
    applyProposals: options.applyProposals ?? false,
  };
}

function append(
  install: LoopTemplateInstall,
  heading: string,
): AutomationAction {
  return {
    kind: "append_document_section",
    documentId: install.documentId ?? "",
    heading,
    body: "{{agent.answer}}",
  };
}

function scheduled(
  frequency: "monthly" | "quarterly",
  timeZone: string,
): AutomationTrigger {
  return {
    kind: "schedule",
    frequency,
    time: "08:00",
    weekday: 1,
    timeZone,
    forEachIssue: false,
  };
}

function loop(
  install: LoopTemplateInstall,
  input: {
    name: string;
    description: string;
    trigger: AutomationTrigger;
    actions: AutomationAction[];
    contextSources?: LoopContextSource[];
    trustedSources?: LoopSource[];
    guardrails?: Partial<LoopGuardrails>;
  },
): LoopTemplateBuild {
  return {
    automation: {
      name: input.name,
      teamId: install.teamId,
      trigger: input.trigger,
      conditions: [],
      actions: input.actions,
      dailyLimit: 100,
    },
    config: {
      description: input.description,
      executor: install.executor,
      guardrails: loopGuardrailsSchema.parse({
        overlap: "skip",
        ...input.guardrails,
      }),
      contextSources: input.contextSources ?? [],
      trustedSources: input.trustedSources ?? [],
    },
  };
}

const teamProjects = (install: LoopTemplateInstall): LoopContextSource => ({
  kind: "team_projects",
  teamId: install.teamId,
});

export const loopTemplates: LoopTemplate[] = [
  {
    id: "monthly-project-updates",
    name: "Monthly project updates",
    needsDocument: false,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Monthly project updates",
        description: "Posts an update for every active project of the team.",
        trigger: scheduled("monthly", install.timeZone),
        contextSources: [teamProjects(install)],
        actions: [
          {
            kind: "write_project_updates",
            projectIds: [],
            providerId: install.providerId,
            model: install.model,
          },
        ],
      }),
  },
  {
    id: "refresh-project-descriptions",
    name: "Refresh project descriptions",
    needsDocument: false,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Refresh project descriptions",
        description:
          "Rewrites project descriptions from the team template and members.",
        trigger: scheduled("monthly", install.timeZone),
        contextSources: [teamProjects(install)],
        guardrails: { approvalRequired: true },
        actions: [
          ask(
            install,
            "Rewrite the description of every active project below using the team's project template. Name the lead and members.\n\n{{context}}",
            { applyProposals: true },
          ),
        ],
      }),
  },
  {
    id: "agentic-bug-resolving",
    name: "Agentic bug resolving",
    needsDocument: false,
    placements: ["sandbox"],
    build: (install) =>
      loop(install, {
        name: "Agentic bug resolving",
        description:
          "Attempts a fix for triaged bugs in a sandbox and asks what is unclear.",
        trigger: { kind: "issue_triaged" },
        contextSources: [{ kind: "trigger_payload" }],
        trustedSources: ["sentry"],
        guardrails: { pauseAfterFailures: 3 },
        actions: [
          {
            kind: "delegate",
            profileId: install.executor.targetId ?? "",
            task: "fix",
            instructions:
              "Fix {{issue.identifier}}: {{issue.title}}\n\n{{issue.description}}\n\n{{context}}",
            acceptanceCriteria: "",
          },
          ask(
            install,
            "List the open questions about {{issue.identifier}} that block a confident fix.\n\n{{context}}",
            { postAnswer: true },
          ),
        ],
      }),
  },
  {
    id: "quarterly-team-report",
    name: "Quarterly team report",
    needsDocument: true,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Quarterly team report",
        description: "Appends a quarterly report to a document.",
        trigger: scheduled("quarterly", install.timeZone),
        contextSources: [
          teamProjects(install),
          { kind: "previous_runs", runCount: 1 },
        ],
        actions: [
          ask(
            install,
            "Write the quarterly report for the team: shipped work, project health, risks and next quarter's focus.\n\n{{context}}",
          ),
          append(install, "Quarterly report {{date}}"),
        ],
      }),
  },
  {
    id: "monthly-security-report",
    name: "Monthly security & API report",
    needsDocument: false,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Monthly security & API report",
        description:
          "Checks dependencies, secrets and API changes and files a report.",
        trigger: scheduled("monthly", install.timeZone),
        contextSources: [teamProjects(install)],
        actions: [
          ask(
            install,
            "Check the team's repositories for vulnerable dependencies, leaked secrets and breaking API changes. Report findings by severity.\n\n{{context}}",
          ),
          {
            kind: "create_issue",
            title: "Security & API report {{date}}",
            description: "{{agent.answer}}",
            statusId: null,
            priority: "none",
            assigneeId: null,
            labelIds: [],
            subIssue: false,
          },
        ],
      }),
  },
  {
    id: "grafana-reconciliation",
    name: "Grafana alert reconciliation",
    needsDocument: false,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Grafana alert reconciliation",
        description: "Matches Grafana alerts to issues and files new ones.",
        trigger: { kind: "source_event", source: "grafana", contains: "" },
        contextSources: [{ kind: "trigger_payload" }],
        trustedSources: ["grafana"],
        guardrails: { overlap: "queue" },
        actions: [
          ask(
            install,
            "Summarize this Grafana alert, its likely cause and the affected service.\n\n{{source.title}}\n{{source.body}}\n\n{{context}}",
          ),
          {
            kind: "create_issue",
            title: "{{source.title}}",
            description: "{{agent.answer}}",
            statusId: null,
            priority: "high",
            assigneeId: null,
            labelIds: [],
            subIssue: false,
          },
        ],
      }),
  },
  {
    id: "maintain-changelog",
    name: "Maintain changelog",
    needsDocument: true,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Maintain changelog",
        description: "Writes release notes into the changelog document.",
        trigger: { kind: "release_event", pipelineIds: [] },
        contextSources: [
          { kind: "trigger_payload" },
          { kind: "previous_runs", runCount: 1 },
        ],
        actions: [
          ask(
            install,
            "Write the changelog entry for {{deployment.version}} in {{deployment.environment}}. Group changes into Added, Changed and Fixed.\n\n{{context}}",
          ),
          append(install, "{{deployment.version}}"),
        ],
      }),
  },
  {
    id: "role-architecture-documents",
    name: "Role and architecture documents",
    needsDocument: true,
    placements: null,
    build: (install) =>
      loop(install, {
        name: "Role and architecture documents",
        description:
          "Keeps role details, a role overview and the technical architecture current.",
        trigger: scheduled("monthly", install.timeZone),
        contextSources: [teamProjects(install)],
        actions: [
          ask(
            install,
            "Describe each role on the active projects below: responsibilities, owners and handoffs.\n\n{{context}}",
          ),
          append(install, "Role details {{date}}"),
          ask(
            install,
            "Summarize all roles across the active projects in one overview table.\n\n{{context}}",
          ),
          append(install, "Role overview {{date}}"),
          ask(
            install,
            "Describe the technical architecture of the active projects: components, data flow and dependencies.\n\n{{context}}",
          ),
          append(install, "Technical architecture {{date}}"),
        ],
      }),
  },
];

export function loopTemplateProblem(
  template: LoopTemplate,
  install: LoopTemplateInstall,
): string | null {
  if (template.needsDocument && !install.documentId)
    return "Choose a document.";
  if (
    template.placements &&
    !template.placements.includes(install.executor.placement)
  )
    return "Choose a cloud sandbox profile.";
  return null;
}
