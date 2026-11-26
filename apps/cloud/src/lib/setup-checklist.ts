import {
  holderCan,
  type CloudPermission,
  type PermissionHolder,
} from "./cloud-permissions";

export interface SetupFacts {
  gitConnections: number;
  repositories: number;
  personalGitAccount: boolean;
  aiProviders: number;
  executionProfiles: number;
  members: number;
  invitations: number;
}

export interface SetupStep {
  id: string;
  label: string;
  action: string;
  href: string;
  done: boolean;
}

interface SetupStepDefinition extends Omit<SetupStep, "done"> {
  permission: CloudPermission | null;
  visible: (facts: SetupFacts) => boolean;
  done: (facts: SetupFacts) => boolean;
}

const always = () => true;

const setupSteps: readonly SetupStepDefinition[] = [
  {
    id: "git",
    label: "Connect GitHub",
    action: "Connect",
    href: "/cloud/settings/integrations?connect=github",
    permission: "git.manage",
    visible: always,
    done: (facts) => facts.gitConnections > 0,
  },
  {
    id: "repositories",
    label: "Add repositories",
    action: "Add",
    href: "/cloud/settings/integrations",
    permission: "git.manage",
    visible: (facts) => facts.gitConnections > 0,
    done: (facts) => facts.repositories > 0,
  },
  {
    id: "account",
    label: "Link your GitHub account",
    action: "Link",
    href: "/cloud/settings/connected-accounts",
    permission: null,
    visible: (facts) => facts.gitConnections > 0,
    done: (facts) => facts.personalGitAccount,
  },
  {
    id: "ai",
    label: "Add an AI provider",
    action: "Add",
    href: "/cloud/settings/ai",
    permission: "ai.manage",
    visible: always,
    done: (facts) => facts.aiProviders > 0,
  },
  {
    id: "execution",
    label: "Choose where agents run",
    action: "Set up",
    href: "/cloud/settings/execution",
    permission: "ai.manage",
    visible: always,
    done: (facts) => facts.executionProfiles > 0,
  },
  {
    id: "members",
    label: "Invite your team",
    action: "Invite",
    href: "/cloud/settings/invitations",
    permission: "members.manage",
    visible: always,
    done: (facts) => facts.members > 1 || facts.invitations > 0,
  },
];

export function setupChecklist(
  holder: PermissionHolder,
  facts: SetupFacts,
): SetupStep[] {
  return setupSteps
    .filter(
      (step) =>
        (!step.permission || holderCan(holder, step.permission)) &&
        step.visible(facts),
    )
    .map(({ id, label, action, href, done }) => ({
      id,
      label,
      action,
      href,
      done: done(facts),
    }));
}
