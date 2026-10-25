import { notFound } from "next/navigation";
import { CyclePlanning } from "@/components/cloud/cycle-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function CyclePage({
  params,
}: {
  params: Promise<{ cycleId: string }>;
}) {
  const id = cloudId.safeParse((await params).cycleId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    return (
      <CyclePlanning
        detail={await runtime.cycles.get(actor, id.data)}
        workspace={await runtime.planning.workspace(actor)}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
