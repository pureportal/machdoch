import { ReleaseList } from "@/components/cloud/release-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ReleasesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, products, releases] = await Promise.all([
    requireCloudWorkspace(),
    runtime.releases.products.list(actor),
    runtime.releases.releases.list(actor),
  ]);
  return (
    <ReleaseList workspace={workspace} products={products} initial={releases} />
  );
}
