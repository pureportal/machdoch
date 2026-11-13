import { notFound } from "next/navigation";
import { ReviewList } from "@/components/cloud/review-list";
import { holderCan } from "@/lib/cloud-permissions";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function ReviewsPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "git.view")) notFound();
  return <ReviewList initial={await runtime.git.pullRequests.reviews(actor)} />;
}
