import { SavedViewList } from "@/components/cloud/saved-view-list";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function ViewsPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const [views, labels, favorites] = await Promise.all([
    runtime.views.list(actor),
    runtime.labels.listVisible(actor),
    runtime.favorites.list(actor),
  ]);
  return (
    <SavedViewList
      views={views}
      labels={labels}
      favorites={
        new Set(
          favorites
            .filter((favorite) => favorite.kind === "view")
            .map((favorite) => favorite.id),
        )
      }
      workspace={workspace}
    />
  );
}
