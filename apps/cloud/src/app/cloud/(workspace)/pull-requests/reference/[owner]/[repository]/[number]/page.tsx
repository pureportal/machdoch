import { notFound, redirect } from "next/navigation";
import { holderCan } from "@/lib/cloud-permissions";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function PullRequestReferenceRoute({
  params,
}: {
  params: Promise<{ owner: string; repository: string; number: string }>;
}) {
  const { owner, repository, number } = await params;
  if (!/^\d{1,7}$/.test(number)) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "git.view")) notFound();
  const id = await runtime.git.pullRequests.find(
    actor,
    `${decodeURIComponent(owner)}/${decodeURIComponent(repository)}`,
    Number(number),
  );
  if (!id) notFound();
  redirect(`/cloud/pull-requests/${id}`);
}
