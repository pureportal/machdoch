import { notFound } from "next/navigation";
import { PipelineList } from "@/components/cloud/pipeline-list";
import { holderCan } from "@/lib/cloud-permissions";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function PipelinesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  const [pipelines, repositories] = await Promise.all([
    runtime.releases.pipelines.list(actor, { query: "", archived: false }),
    holderCan(workspace.actor, "git.view")
      ? runtime.git.connections.repositories(actor)
      : Promise.resolve([]),
  ]);
  return (
    <PipelineList
      workspace={workspace}
      repositories={repositories}
      initial={pipelines}
    />
  );
}