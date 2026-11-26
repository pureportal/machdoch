import type { CloudActor } from "../../lib/cloud-contract";
import type { SetupFacts } from "../../lib/setup-checklist";
import { requireMembership } from "./access";
import type { CloudDatabase } from "./database";

export class CloudSetupStatus {
  constructor(private readonly database: CloudDatabase) {}

  facts(actor: CloudActor): Promise<SetupFacts> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const row = (
        await sql.query<{
          git_connections: number;
          repositories: number;
          personal_git_account: boolean;
          ai_providers: number;
          execution_profiles: number;
          members: number;
          invitations: number;
        }>(
          `SELECT
          (SELECT count(*)::int FROM cloud_git_connections WHERE organization_id=$1) AS git_connections,
          (SELECT count(*)::int FROM cloud_git_repositories WHERE organization_id=$1) AS repositories,
          EXISTS(SELECT 1 FROM cloud_git_accounts a JOIN cloud_git_connections c ON c.organization_id=a.organization_id AND c.provider=a.provider AND c.api_url=a.api_url
            WHERE a.organization_id=$1 AND a.user_id=$2) AS personal_git_account,
          (SELECT count(*)::int FROM cloud_ai_providers WHERE organization_id=$1 AND enabled) AS ai_providers,
          (SELECT count(*)::int FROM cloud_execution_profiles WHERE organization_id=$1 AND enabled) AS execution_profiles,
          (SELECT count(*)::int FROM cloud_memberships WHERE organization_id=$1 AND active) AS members,
          (SELECT count(*)::int FROM cloud_invitations WHERE organization_id=$1 AND revoked_at IS NULL) AS invitations`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0]!;
      return {
        gitConnections: row.git_connections,
        repositories: row.repositories,
        personalGitAccount: row.personal_git_account,
        aiProviders: row.ai_providers,
        executionProfiles: row.execution_profiles,
        members: row.members,
        invitations: row.invitations,
      };
    });
  }
}
