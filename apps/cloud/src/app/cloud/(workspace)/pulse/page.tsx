import { PulseFeed } from "@/components/cloud/pulse-feed";
import { holderCan } from "@/lib/cloud-permissions";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

const reportedStatuses = new Set(["active", "planned", "paused"]);

export default async function PulsePage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const member = workspace.actor;
  const writer =
    holderCan(member, "planning.edit") && holderCan(member, "ai.chat");
  return (
    <PulseFeed
      updates={await runtime.projectUpdates.feed(actor)}
      teams={workspace.teams.map(({ id, name }) => ({ id, name }))}
      projects={workspace.projects.map(({ id, name, teamId }) => ({
        id,
        name,
        teamId,
      }))}
      writableProjects={
        writer
          ? workspace.projects
              .filter((project) => reportedStatuses.has(project.status))
              .sort(
                (left, right) =>
                  Number(right.status === "active") -
                  Number(left.status === "active"),
              )
              .map(({ id, name }) => ({ id, name }))
          : []
      }
      canEditInstructions={holderCan(member, "ai.manage")}
    />
  );
}
