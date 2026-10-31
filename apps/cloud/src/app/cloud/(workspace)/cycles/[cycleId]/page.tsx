import { notFound } from "next/navigation";
import { CyclePlanning } from "@/components/cloud/cycle-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function CyclePage({
  params,
}: {
  params: Promise<{ cycleId: string }>;
}) {
  const id = cloudId.safeParse((await params).cycleId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    const [detail, burnup, { workspace }] = await Promise.all([
      runtime.cycles.get(actor, id.data),
      runtime.cycles.burnup(actor, id.data),
      requireCloudWorkspace(),
    ]);
    return (
      <CyclePlanning detail={detail} burnup={burnup} workspace={workspace} />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
