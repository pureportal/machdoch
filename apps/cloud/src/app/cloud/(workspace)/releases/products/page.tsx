import { notFound } from "next/navigation";
import { ProductList } from "@/components/cloud/product-list";
import { holderCan } from "@/lib/cloud-permissions";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ProductsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "releases.view")) notFound();
  const products = await runtime.releases.products.list(actor);
  return <ProductList workspace={workspace} initial={products} />;
}
