import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/cloud/task-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const id = cloudId.safeParse((await params).runId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    return (
      <TaskDetail
        initial={await runtime.execution.runs.get(actor, id.data)}
        workspace={(await requireCloudWorkspace()).workspace}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
