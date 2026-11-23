import { notFound } from "next/navigation";
import { PipelineRelease } from "@/components/cloud/pipeline-release";
import { cloudId } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function PipelineReleasePage({
  params,
}: {
  params: Promise<{ pipelineId: string; releaseId: string }>;
}) {
  const { pipelineId, releaseId } = await params;
  const pipeline = cloudId.safeParse(pipelineId);
  const release = cloudId.safeParse(releaseId);
  if (!pipeline.success || !release.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  try {
    const [detail, products] = await Promise.all([
      runtime.releases.pipelineReleases.get(actor, release.data),
      runtime.releases.products.list(actor),
    ]);
    if (detail.pipelineId !== pipeline.data) notFound();
    return (
      <PipelineRelease
        workspace={workspace}
        release={detail}
        products={products}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}