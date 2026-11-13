import { notFound } from "next/navigation";
import { PullRequestPage } from "@/components/cloud/pull-request-page";
import { cloudId } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function PullRequestRoute({
  params,
  searchParams,
}: {
  params: Promise<{ pullRequestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = cloudId.safeParse((await params).pullRequestId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "git.view")) notFound();
  const tab = (await searchParams).tab;
  try {
    return (
      <PullRequestPage
        key={id.data}
        initial={await runtime.git.pullRequests.get(actor, id.data)}
        initialTab={typeof tab === "string" ? tab : null}
        launch={holderCan(workspace.actor, "clients.manage")}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
