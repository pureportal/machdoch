import { notFound } from "next/navigation";
import { InitiativeDetail } from "@/components/cloud/initiative-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function InitiativePage({
  params,
}: {
  params: Promise<{ initiativeId: string }>;
}) {
  const id = cloudId.safeParse((await params).initiativeId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  try {
    const [initiative, progress, updates, initiatives] = await Promise.all([
      runtime.initiatives.get(actor, id.data),
      runtime.projects.progress(actor),
      runtime.projectUpdates.latest(actor),
      runtime.initiatives.list(actor),
    ]);
    return (
      <InitiativeDetail
        key={`${initiative.id}:${initiative.revision}`}
        initiative={initiative}
        workspace={workspace}
        progress={progress}
        updates={updates}
        initiatives={initiatives}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
