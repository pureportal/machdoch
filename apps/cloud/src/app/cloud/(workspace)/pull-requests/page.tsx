import { PullRequestList } from "@/components/cloud/pull-request-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function PullRequestsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const role = (await requireCloudWorkspace()).workspace.actor.role;
  return (
    <PullRequestList
      initial={await runtime.github.pullRequests.list(actor, undefined)}
      admin={role === "owner" || role === "admin"}
    />
  );
}
