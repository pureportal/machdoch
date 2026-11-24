import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitRepositorySettingsInput,
  GitReviewSettings,
  GitReviewSettingsInput,
} from "../../../lib/cloud-git-contract";
import { checkRevision, CloudError, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";

export async function gitReviewSettings(
  sql: CloudSql,
  organizationId: string,
): Promise<GitReviewSettings> {
  return (
    (
      await sql.query<GitReviewSettings & Record<string, unknown>>(
        `SELECT review_guides AS "reviewGuides",merge_issues AS "mergeIssues",commit_links AS "commitLinks",revision
        FROM cloud_git_settings WHERE organization_id=$1`,
        [organizationId],
      )
    ).rows[0] ?? {
      reviewGuides: false,
      mergeIssues: false,
      commitLinks: true,
      revision: 0,
    }
  );
}

export class CloudGitReviewSettings {
  constructor(private readonly database: CloudDatabase) {}

  set(
    actor: CloudActor,
    input: GitReviewSettingsInput,
  ): Promise<GitReviewSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      await sql.query(
        "SELECT 1 FROM cloud_organizations WHERE id=$1 FOR UPDATE",
        [actor.organizationId],
      );
      const current = await gitReviewSettings(sql, actor.organizationId);
      checkRevision(current.revision, input.revision);
      await sql.query(
        `INSERT INTO cloud_git_settings (organization_id,review_guides,merge_issues,commit_links) VALUES ($1,$2,$3,$4)
        ON CONFLICT (organization_id) DO UPDATE SET review_guides=$2,merge_issues=$3,commit_links=$4,revision=cloud_git_settings.revision+1`,
        [
          actor.organizationId,
          input.reviewGuides,
          input.mergeIssues,
          input.commitLinks,
        ],
      );
      return gitReviewSettings(sql, actor.organizationId);
    });
  }

  setRepositorySettings(
    actor: CloudActor,
    repositoryId: string,
    input: GitRepositorySettingsInput,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      if (input.issueSync && !input.teamId)
        throw new CloudError(
          422,
          "team_required",
          "Choose a team before syncing issues.",
        );
      if (input.teamId) {
        const team = await sql.query(
          "SELECT 1 FROM cloud_teams WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, input.teamId],
        );
        if (!team.rows.length)
          throw new CloudError(404, "not_found", "Team is unavailable.");
      }
      const updated = await sql.query(
        "UPDATE cloud_git_repositories SET team_id=$3,issue_sync=$4 WHERE organization_id=$1 AND id=$2 RETURNING id",
        [actor.organizationId, repositoryId, input.teamId, input.issueSync],
      );
      if (!updated.rows.length)
        throw new CloudError(404, "not_found", "Repository is unavailable.");
    });
  }
}
