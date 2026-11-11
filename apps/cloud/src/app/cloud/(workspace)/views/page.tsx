import { SavedViewList } from "@/components/cloud/saved-view-list";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function ViewsPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  return (
    <SavedViewList
      views={await runtime.views.list(actor)}
      workspace={workspace}
    />
  );
}
