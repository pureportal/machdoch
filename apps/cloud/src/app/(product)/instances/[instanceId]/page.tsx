import { InstanceProduct } from "./instance-product";
import { requireUsableInstancePage } from "@/server/page-auth";

export const dynamic = "force-dynamic";

export default async function InstanceProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}): Promise<React.ReactElement> {
  const { instanceId } = await params;
  const { session } = await searchParams;
  const instance = await requireUsableInstancePage(instanceId);
  return (
    <InstanceProduct
      instanceId={instance.instanceId}
      instanceName={instance.displayName}
      {...(typeof session === "string" &&
      session.length > 0 &&
      session.length <= 240
        ? { initialSessionId: session }
        : {})}
    />
  );
}
