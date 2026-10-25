import { notFound } from "next/navigation";
import { IssueEditor } from "@/components/cloud/issue-editor";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function IssuePage({
  params,
}: {
  params: Promise<{ issueId: string }>;
}) {
  const id = cloudId.safeParse((await params).issueId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    const issue = await runtime.planning.getIssue(actor, id.data);
    const workspace = await runtime.planning.workspace(actor);
    return <IssueEditor initial={issue} workspace={workspace} />;
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
