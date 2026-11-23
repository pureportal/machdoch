import { notFound } from "next/navigation";
import { PipelineDetail } from "@/components/cloud/pipeline-detail";
import { cloudId } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function PipelinePage({
  params,
}: {
  params: Promise<{ pipelineId: string }>;
}) {
  const id = cloudId.safeParse((await params).pipelineId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  try {
    const pipeline = await runtime.releases.pipelines.get(actor, id.data);
    const [repositories, policies] = await Promise.all([
      holderCan(workspace.actor, "git.view")
        ? runtime.git.connections.repositories(actor)
        : Promise.resolve([]),
      Promise.all(
        pipeline.teams.map(async (team) => ({
          teamId: team.id,
          completeOnRelease: await runtime.releases.pipelines.releasePolicy(
            actor,
            team.id,
          ),
        })),
      ),
    ]);
    return (
      <PipelineDetail
        workspace={workspace}
        repositories={repositories}
        pipeline={pipeline}
        policies={policies}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}