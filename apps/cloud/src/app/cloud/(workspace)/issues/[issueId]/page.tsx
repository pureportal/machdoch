import { notFound } from "next/navigation";
import { IssueEditor } from "@/components/cloud/issue-editor";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function IssuePage({
  params,
}: {
  params: Promise<{ issueId: string }>;
}) {
  const id = cloudId.safeParse((await params).issueId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    const [issue, { workspace }, activeRunId] = await Promise.all([
      runtime.planning.getIssue(actor, id.data),
      requireCloudWorkspace(),
      runtime.execution.runs.activeForIssue(actor, id.data),
    ]);
    return (
      <IssueEditor
        initial={issue}
        workspace={workspace}
        activeRunId={activeRunId}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
