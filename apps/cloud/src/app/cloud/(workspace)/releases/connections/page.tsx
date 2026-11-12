import { notFound } from "next/navigation";
import { SocialConnections } from "@/components/cloud/social-connections";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const { workspace } = await requireCloudWorkspace();
  if (!["owner", "admin"].includes(workspace.actor.role)) notFound();
  const [apps, accounts, query] = await Promise.all([
    runtime.releases.social.apps(actor),
    runtime.releases.social.accounts(actor),
    searchParams,
  ]);
  return (
    <SocialConnections
      workspace={workspace}
      initialApps={apps}
      initialAccounts={accounts}
      connected={query.connected ?? null}
      error={query.error ?? null}
    />
  );
}
