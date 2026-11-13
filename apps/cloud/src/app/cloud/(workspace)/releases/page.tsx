import { notFound } from "next/navigation";
import { ReleaseList } from "@/components/cloud/release-list";
import { holderCan } from "@/lib/cloud-permissions";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ReleasesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  const [products, releases] = await Promise.all([
    runtime.releases.products.list(actor),
    runtime.releases.releases.list(actor),
  ]);
  return (
    <ReleaseList workspace={workspace} products={products} initial={releases} />
  );
}
