import { notFound, redirect } from "next/navigation";
import { cloudId } from "@/lib/cloud-contract";
import { savedViewHref } from "@/lib/cloud-view-contract";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function SavedViewPage({
  params,
}: {
  params: Promise<{ viewId: string }>;
}) {
  const id = cloudId.safeParse((await params).viewId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudWorkspace();
  const view = (await runtime.views.list(actor)).find(
    (entry) => entry.id === id.data,
  );
  if (!view) notFound();
  redirect(savedViewHref(view));
}
