import { notFound } from "next/navigation";
import { LoopDetail } from "@/components/cloud/loop-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function LoopPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = cloudId.safeParse((await params).id);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  try {
    const loop = await runtime.automations.loops.get(actor, id.data);
    const [automation, schedule, status] = await Promise.all([
      loop.kind === "automation"
        ? runtime.automations.service.get(actor, loop.id)
        : Promise.resolve(null),
      loop.kind === "schedule"
        ? runtime.schedules.get(actor, loop.id)
        : Promise.resolve(null),
      runtime.schedules.status(actor),
    ]);
    return (
      <LoopDetail
        workspace={workspace}
        loop={loop}
        automation={automation}
        schedule={schedule}
        workerAvailable={status.available}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
