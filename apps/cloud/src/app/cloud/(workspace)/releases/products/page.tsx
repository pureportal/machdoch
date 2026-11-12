import { ProductList } from "@/components/cloud/product-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ProductsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, products] = await Promise.all([
    requireCloudWorkspace(),
    runtime.releases.products.list(actor),
  ]);
  return <ProductList workspace={workspace} initial={products} />;
}
