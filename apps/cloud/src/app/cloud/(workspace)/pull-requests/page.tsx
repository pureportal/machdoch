import { notFound } from "next/navigation";
import { PullRequestList } from "@/components/cloud/pull-request-list";
import { holderCan } from "@/lib/cloud-permissions";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function PullRequestsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const member = (await requireCloudWorkspace()).workspace.actor;
  if (!holderCan(member, "git.view")) notFound();
  return (
    <PullRequestList
      initial={await runtime.git.pullRequests.list(actor, undefined)}
      manageGit={holderCan(member, "git.manage")}
      launch={holderCan(member, "clients.manage")}
    />
  );
}
