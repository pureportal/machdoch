import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudFavorite,
  FavoriteInput,
  IssueSubscription,
} from "../../lib/cloud-favorite-contract";
import { CloudError, requireMembership, teamVisibility } from "./access";
import type { CloudDatabase } from "./database";
import { readIssue } from "./planning";
import { issueSubscribedClause } from "./subscription-records";

const favoriteEntities = `SELECT i.id,'issue' AS kind,i.identifier||' '||i.title AS label,i.state,i.team_id FROM cloud_issues i WHERE i.organization_id=$1 AND NOT i.archived
  UNION ALL SELECT p.id,'project',p.name,p.status,p.team_id FROM cloud_projects p WHERE p.organization_id=$1
  UNION ALL SELECT c.id,'cycle',c.name,c.status,c.team_id FROM cloud_cycles c WHERE c.organization_id=$1`;

export class CloudFavorites {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<CloudFavorite[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudFavorite & Record<string, unknown>>(
          `SELECT f.kind,f.entity_id AS id,e.label,e.state FROM cloud_favorites f
          JOIN (${favoriteEntities}) e ON e.id=f.entity_id AND e.kind=f.kind
          JOIN cloud_teams t ON t.organization_id=f.organization_id AND t.id=e.team_id
          JOIN cloud_memberships m ON m.organization_id=f.organization_id AND m.user_id=$2
          WHERE f.organization_id=$1 AND f.user_id=$2 AND ${teamVisibility}
          ORDER BY f.created_at,f.entity_id LIMIT 50`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  set(actor: CloudActor, input: FavoriteInput): Promise<{ favorite: boolean }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      if (!input.favorite) {
        await sql.query(
          "DELETE FROM cloud_favorites WHERE organization_id=$1 AND user_id=$2 AND kind=$3 AND entity_id=$4",
          [actor.organizationId, actor.userId, input.kind, input.id],
        );
        return { favorite: false };
      }
      const visible = await sql.query(
        `SELECT 1 FROM (${favoriteEntities}) e JOIN cloud_teams t ON t.organization_id=$1 AND t.id=e.team_id
        JOIN cloud_memberships m ON m.organization_id=$1 AND m.user_id=$2 WHERE e.id=$3 AND e.kind=$4 AND ${teamVisibility}`,
        [actor.organizationId, actor.userId, input.id, input.kind],
      );
      if (!visible.rows.length)
        throw new CloudError(404, "not_found", "This item is unavailable.");
      await sql.query(
        "INSERT INTO cloud_favorites (organization_id,user_id,kind,entity_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [actor.organizationId, actor.userId, input.kind, input.id],
      );
      return { favorite: true };
    });
  }
}

export class CloudIssueSubscriptions {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, issueId: string): Promise<IssueSubscription> {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      const subscribers = (
        await sql.query<{ id: string; name: string }>(
          `SELECT u.id,u.name FROM cloud_issues i
          JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.active
          JOIN cloud_users u ON u.id=m.user_id AND NOT u.disabled
          WHERE i.organization_id=$1 AND i.id=$2 AND ${issueSubscribedClause} ORDER BY u.name,u.id`,
          [actor.organizationId, issueId],
        )
      ).rows;
      return {
        subscribed: subscribers.some((entry) => entry.id === actor.userId),
        subscribers,
      };
    });
  }

  set(
    actor: CloudActor,
    issueId: string,
    subscribed: boolean,
  ): Promise<IssueSubscription> {
    return this.database
      .transaction(async (sql) => {
        await requireMembership(sql, actor);
        await readIssue(sql, actor, issueId);
        await sql.query(
          `INSERT INTO cloud_issue_subscriptions (organization_id,issue_id,user_id,subscribed) VALUES ($1,$2,$3,$4)
          ON CONFLICT (organization_id,issue_id,user_id) DO UPDATE SET subscribed=EXCLUDED.subscribed,updated_at=clock_timestamp()`,
          [actor.organizationId, issueId, actor.userId, subscribed],
        );
      })
      .then(() => this.get(actor, issueId));
  }
}
