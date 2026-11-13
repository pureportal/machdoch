import { notFound } from "next/navigation";
import { holderCan } from "@/lib/cloud-permissions";
import { ReleaseStudio } from "@/components/cloud/release-studio";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ReleasePage({
  params,
}: {
  params: Promise<{ releaseId: string }>;
}) {
  const id = cloudId.safeParse((await params).releaseId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  try {
    const [release, capabilities] = await Promise.all([
      runtime.releases.releases.get(actor, id.data),
      runtime.releases.studio.capabilities(),
    ]);
    const [{ product, channels }, media] = await Promise.all([
      runtime.releases.products.get(actor, release.productId),
      runtime.releases.media.list(actor, {
        productId: release.productId,
        releaseId: release.id,
      }),
    ]);
    return (
      <ReleaseStudio
        key={release.id}
        workspace={workspace}
        product={product}
        channels={channels}
        initial={release}
        initialMedia={media}
        capabilities={capabilities}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
