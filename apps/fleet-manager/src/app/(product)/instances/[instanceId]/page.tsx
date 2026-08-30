import { notFound } from "next/navigation";
import { InstanceProduct } from "./instance-product";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function InstanceProductPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<React.ReactElement> {
  await requirePageSession();
  const { instanceId } = await params;
  const instance = getRuntime().fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) notFound();
  return (
    <InstanceProduct
      instanceId={instance.instanceId}
      instanceName={instance.displayName}
    />
  );
}
