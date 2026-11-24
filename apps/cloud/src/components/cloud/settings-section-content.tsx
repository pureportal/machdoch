import Link from "next/link";
import { AnalyticsPrivacyControl } from "@machdoch/analytics/privacy-control";
import type {
  SettingsAccess,
  SettingsSectionId,
} from "@/lib/settings-navigation";
import { settingsSections, teamSettingsHref } from "@/lib/settings-navigation";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { AppearancePreferences } from "@/components/fleet-appearance";
import type { requireCloudPageSession } from "@/server/cloud/page-auth";
import { AccountCredentials } from "./account-credentials";
import { AccountSessions } from "./account-sessions";
import { AccountTwoFactor } from "./account-two-factor";
import { CloudConnections } from "./connections";
import { ExecutionSettings } from "./execution-settings";
import { GitAccountSettings } from "./git-accounts";
import { GitSettings } from "./git-settings";
import { LabelManager } from "./label-manager";
import { LoopSettingsPanel } from "./loop-settings";
import { PersonAvatar } from "./person-avatar";
import { AiProviderSettings } from "./provider-settings";
import { PulseInstructionsEditor } from "./pulse-instructions";
import { ProjectStatusManager } from "./project-status-manager";
import {
  AgentInstructionsSetting,
  ProjectUpdateCadenceSetting,
  ReviewPreferences,
} from "./setting-forms";
import { CloudSettings, type AdministrationSection } from "./settings";
import { SlaManager } from "./sla-manager";
import { SsoAccount } from "./sso-account";

type PageSession = Awaited<ReturnType<typeof requireCloudPageSession>>;
type CloudRuntime = PageSession["runtime"];
type SessionActor = PageSession["actor"];

const administrationSections = new Set<string>([
  "branding",
  "invitations",
  "roles",
  "sso",
  "email",
  "mimorii",
] satisfies AdministrationSection[]);

function isAdministrationSection(
  section: SettingsSectionId,
): section is AdministrationSection {
  return administrationSections.has(section);
}

const sectionLinks: Partial<
  Record<SettingsSectionId, { href: string; label: string }>
> = {
  loops: { href: "/cloud/loops", label: "Open loops" },
  initiatives: { href: "/cloud/initiatives", label: "Open initiatives" },
  releases: { href: "/cloud/releases", label: "Open releases" },
};

export async function SettingsSectionContent({
  section,
  access,
  runtime,
  actor,
  workspace,
  project,
}: {
  section: SettingsSectionId;
  access: Exclude<SettingsAccess, "hidden">;
  runtime: CloudRuntime;
  actor: SessionActor;
  workspace: CloudWorkspace;
  project: string | null;
}) {
  const writable = access === "edit";
  if (section === "members" && !writable)
    return <MemberList workspace={workspace} />;
  if (section === "members" || isAdministrationSection(section))
    return (
      <CloudSettings
        data={await runtime.administration.get(actor)}
        actor={workspace.actor}
        section={section}
      />
    );
  if (section === "loops" && holderCan(workspace.actor, "ai.manage")) {
    const [settings, sources, repositories] = await Promise.all([
      runtime.automations.loops.getSettings(actor),
      runtime.automations.sources.list(actor),
      runtime.git.connections.repositories(actor),
    ]);
    return (
      <LoopSettingsPanel
        workspace={workspace}
        settings={settings}
        sources={sources}
        repositories={repositories}
      />
    );
  }
  switch (section) {
    case "preferences":
      return (
        <div className="cloud-settings">
          <AppearancePreferences />
          <section className="cloud-settings-section [&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:accent-[var(--primary)] [&_label]:font-medium">
            <AnalyticsPrivacyControl />
          </section>
        </div>
      );
    case "profile":
      return (
        <div className="cloud-settings">
          <section className="cloud-settings-section">
            <dl className="cloud-properties">
              <div>
                <dt>Name</dt>
                <dd>{workspace.actor.name}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{workspace.actor.roleName}</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>{workspace.organization.name}</dd>
              </div>
            </dl>
          </section>
        </div>
      );
    case "security": {
      const [twoFactor, credentials, identities, connections] =
        await Promise.all([
          runtime.authentication.twoFactor.status(actor),
          runtime.authentication.credentials.status(actor),
          runtime.authentication.ssoProviders.account(actor),
          runtime.authorization.connections(actor),
        ]);
      return (
        <div className="cloud-settings">
          <AccountTwoFactor status={twoFactor} />
          <AccountCredentials account={actor} credentials={credentials} />
          <SsoAccount identities={identities} />
          <AccountSessions account={actor} />
          <CloudConnections connections={connections} origin={runtime.origin} />
        </div>
      );
    }
    case "connected-accounts":
      return (
        <div className="cloud-settings">
          <GitAccountSettings />
        </div>
      );
    case "code-reviews": {
      const personal = await runtime.settings.personal(actor);
      return (
        <div className="cloud-settings">
          <ReviewPreferences
            diffLayout={personal["review.diffLayout"] ?? "unified"}
            showWhitespace={personal["review.showWhitespace"] ?? true}
          />
        </div>
      );
    }
    case "agent-personalization": {
      const [personal, organization, teams] = await Promise.all([
        runtime.settings.personal(actor),
        runtime.settings.organization(actor),
        Promise.all(
          workspace.teams.map(async (team) => ({
            team,
            values: await runtime.settings.team(actor, team.id),
          })),
        ),
      ]);
      const teamsWritable = holderCan(workspace.actor, "teams.manage");
      return (
        <div className="cloud-settings">
          <AgentInstructionsSetting
            label="Your instructions"
            scope="user"
            initial={personal["agent.instructions"] ?? ""}
            writable
          />
          <AgentInstructionsSetting
            label={workspace.organization.name}
            scope="organization"
            initial={organization["agent.instructions"] ?? ""}
            writable={holderCan(workspace.actor, "settings.manage")}
          />
          {teams.map(({ team, values }) => (
            <AgentInstructionsSetting
              key={team.id}
              label={team.name}
              scope="team"
              teamId={team.id}
              initial={values["agent.instructions"] ?? ""}
              writable={teamsWritable}
            />
          ))}
        </div>
      );
    }
    case "ai":
      return (
        <AiProviderSettings
          settings={await runtime.aiProviders.list(actor, true)}
        />
      );
    case "execution": {
      const [profiles, providers] = await Promise.all([
        runtime.execution.profiles.list(actor),
        runtime.aiProviders.list(actor, true),
      ]);
      return (
        <ExecutionSettings
          workspace={workspace}
          profiles={profiles}
          providers={providers.providers}
          focusProjectId={project}
        />
      );
    }
    case "integrations":
      if (writable) return <GitSettings />;
      return (
        <RepositoryList
          repositories={await runtime.git.connections.repositories(actor)}
        />
      );
    case "issue-labels":
      return (
        <TeamRows workspace={workspace}>
          {(team) => (
            <LabelManager
              teamId={team.id}
              teamName={team.name}
              writable={writable}
            />
          )}
        </TeamRows>
      );
    case "slas":
      return (
        <TeamRows workspace={workspace}>
          {(team) => (
            <SlaManager
              teamId={team.id}
              teamName={team.name}
              writable={writable}
            />
          )}
        </TeamRows>
      );
    case "project-statuses":
      return (
        <ProjectStatusManager
          statuses={workspace.projectStatuses}
          writable={writable}
        />
      );
    case "project-updates":
      return (
        <div className="cloud-settings">
          <ProjectUpdateCadenceSetting
            cadence={
              (await runtime.settings.organization(actor))[
                "projects.updateCadence"
              ] ?? "none"
            }
            writable={writable}
          />
        </div>
      );
    case "workflow-states":
      return (
        <TeamRows workspace={workspace}>
          {(team) => (
            <Link
              className="cloud-text-link"
              href={teamSettingsHref(team.id, "workflow")}
            >
              {settingsSections["workflow-states"].label}
            </Link>
          )}
        </TeamRows>
      );
    case "pulse":
      return (
        <div className="cloud-settings">
          <section className="cloud-settings-section">
            <header>
              <h2>Instructions</h2>
              {writable && <PulseInstructionsEditor />}
            </header>
          </section>
        </div>
      );
    default: {
      const link = sectionLinks[section];
      return (
        <div className="cloud-empty">
          <p>Nothing to configure yet.</p>
          {link && (
            <Link className="cloud-text-link" href={link.href}>
              {link.label}
            </Link>
          )}
        </div>
      );
    }
  }
}

function MemberList({ workspace }: { workspace: CloudWorkspace }) {
  return (
    <div className="cloud-settings">
      <section className="cloud-settings-section">
        <ul className="cloud-member-list">
          {workspace.members.map((member) => (
            <li key={member.id}>
              <PersonAvatar name={member.name} />
              <div>
                <strong>{member.name}</strong>
              </div>
              <span>{member.roleName}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RepositoryList({
  repositories,
}: {
  repositories: { id: string; provider: string; fullName: string }[];
}) {
  if (!repositories.length)
    return (
      <div className="cloud-empty">
        <p>No repositories connected.</p>
      </div>
    );
  return (
    <div className="cloud-settings">
      <section className="cloud-settings-section">
        <ul className="cloud-member-list">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <div>
                <strong>{repository.fullName}</strong>
              </div>
              <span>{repository.provider}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TeamRows({
  workspace,
  children,
}: {
  workspace: CloudWorkspace;
  children: (team: CloudWorkspace["teams"][number]) => React.ReactNode;
}) {
  return (
    <div className="cloud-settings">
      <section className="cloud-settings-section">
        <ul className="cloud-member-list">
          {workspace.teams.map((team) => (
            <li key={team.id}>
              <div>
                <strong>{team.name}</strong>
                <span>{team.key}</span>
              </div>
              {children(team)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
