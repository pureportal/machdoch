import { notFound } from "next/navigation";
import { DocumentDetail } from "@/components/cloud/document-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const id = cloudId.safeParse((await params).documentId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    return (
      <DocumentDetail
        document={await runtime.automations.loops.getDocument(actor, id.data)}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
