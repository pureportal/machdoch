import Link from "next/link";
import { notFound } from "next/navigation";
import { LabelManager } from "@/components/cloud/label-manager";
import { EstimateScaleEditor } from "@/components/cloud/scale-editor";
import { TeamEditor } from "@/components/cloud/team-editor";
import { WorkflowEditor } from "@/components/cloud/workflow-editor";
import type { CloudTeam, CloudWorkspace } from "@/lib/cloud-contract";
import {
  teamSettingsAccess,
  teamSettingsHref,
  teamSettingsTabs,
  type TeamSettingsTab,
} from "@/lib/settings-navigation";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ teamId: string; tab: string }>;
}) {
  const { teamId, tab } = await params;
  const active = teamSettingsTabs.find((entry) => entry.id === tab);
  const { workspace } = await requireCloudWorkspace();
  const team = workspace.teams.find((entry) => entry.id === teamId);
  if (!active || !team) notFound();
  const writable = teamSettingsAccess(workspace.actor) === "edit";
  return (
    <>
      <header className="cloud-page-header">
        <h1>{team.name}</h1>
      </header>
      <nav className="cloud-section-navigation" aria-label={team.name}>
        {teamSettingsTabs.map((entry) => (
          <Link
            key={entry.id}
            href={teamSettingsHref(team.id, entry.id)}
            aria-current={entry.id === active.id ? "page" : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </nav>
      <TeamSettingsContent
        tab={active.id}
        team={team}
        workspace={workspace}
        writable={writable}
      />
    </>
  );
}

function TeamSettingsContent({
  tab,
  team,
  workspace,
  writable,
}: {
  tab: TeamSettingsTab;
  team: CloudTeam;
  workspace: CloudWorkspace;
  writable: boolean;
}) {
  switch (tab) {
    case "workflow": {
      const workflow = workspace.workflows.find(
        (entry) => entry.teamId === team.id,
      );
      return (
        <div className="cloud-settings">
          <section className="cloud-settings-section">
            <header>
              <h2>Statuses</h2>
              {writable && <WorkflowEditor teamId={team.id} />}
            </header>
            <ul className="cloud-member-list">
              {workflow?.statuses
                .filter((status) => !status.archived)
                .map((status) => (
                  <li key={status.id}>
                    <div>
                      <strong>{status.name}</strong>
                    </div>
                    <span>{status.category}</span>
                  </li>
                ))}
            </ul>
          </section>
          <section className="cloud-settings-section">
            <header>
              <h2>Labels</h2>
              <LabelManager
                teamId={team.id}
                teamName={team.name}
                writable={writable}
              />
            </header>
          </section>
        </div>
      );
    }
    case "estimates":
      return (
        <div className="cloud-settings">
          <section className="cloud-settings-section">
            <header>
              <h2>Estimates</h2>
              {writable && <EstimateScaleEditor team={team} />}
            </header>
            <ul className="cloud-member-list">
              {team.estimateScale.map((card) => (
                <li key={card.label}>
                  <div>
                    <strong>{card.label}</strong>
                  </div>
                  <span>{card.points ?? ""}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      );
    case "members":
      return (
        <div className="cloud-settings">
          <section className="cloud-settings-section">
            <header>
              <h2>{team.name}</h2>
              {writable && <TeamEditor team={team} workspace={workspace} />}
            </header>
          </section>
        </div>
      );
    default:
      return (
        <div className="cloud-empty">
          <p>Nothing to configure yet.</p>
        </div>
      );
  }
}
