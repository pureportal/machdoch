import { notFound, redirect } from "next/navigation";
import { IssueEditor } from "@/components/cloud/issue-editor";
import { cloudId } from "@/lib/cloud-contract";
import { issueIdentifierFormat } from "@/lib/issue-links";
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
  const reference = decodeURIComponent((await params).issueId);
  const id = cloudId.safeParse(reference);
  const { runtime, actor } = await requireCloudPageSession();
  if (!id.success) {
    if (!issueIdentifierFormat.test(reference)) notFound();
    const issue = await runtime.planning.findIssue(actor, reference);
    if (!issue) notFound();
    redirect(`/cloud/issues/${issue.id}`);
  }
  try {
    const [issue, { workspace }, favorites] = await Promise.all([
      runtime.planning.getIssue(actor, id.data),
      requireCloudWorkspace(),
      runtime.favorites.list(actor),
    ]);
    return (
      <IssueEditor
        key={issue.id}
        initial={issue}
        workspace={workspace}
        favorite={favorites.some(
          (entry) => entry.kind === "issue" && entry.id === issue.id,
        )}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
