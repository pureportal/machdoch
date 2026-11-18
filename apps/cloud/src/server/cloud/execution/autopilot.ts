import { randomUUID } from "node:crypto";
import type { issueStates } from "../../../lib/cloud-contract";

import { isCloudError } from "../access";
import type { CloudDatabase } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import { admitRun } from "./admission";

type IssueState = (typeof issueStates)[number];

const activeTasksPerProject = 3;
const batchSize = 10;

export class CloudAutopilot {
  private readonly declined = new Map<string, number>();

  constructor(
    private readonly database: CloudDatabase,
    private readonly issueChanges: CloudIssueChanges,
  ) {}

  async tick(): Promise<number> {
    return (await this.start()) + (await this.block());
  }

  private async move(
    organizationId: string,
    userId: string,
    issueId: string,
    category: IssueState,
  ): Promise<void> {
    try {
      await this.issueChanges.apply(
        { organizationId, userId, automation: "Autopilot" },
        randomUUID(),
        {
          issues: [{ id: issueId }],
          changes: { statusCategory: category },
        },
      );
    } catch (error) {
      if (!isCloudError(error) || ![404, 409, 422].includes(error.status))
        throw error;
    }
  }

  private async start(): Promise<number> {
    const candidates = await this.database.transaction((sql) =>
      sql.query<{
        organization_id: string;
        profile_id: string;
        actor_id: string;
        issue_id: string;
        revision: number;
      }>(
        `SELECT i.organization_id,p.id AS profile_id,i.ai_assigned_by AS actor_id,i.id AS issue_id,i.revision
        FROM cloud_issues i
        CROSS JOIN LATERAL (
          SELECT x.id FROM cloud_execution_profiles x
          WHERE x.organization_id=i.organization_id AND x.project_id=i.project_id AND x.enabled
          ORDER BY (x.definition->>'autopilot')::boolean DESC,x.name,x.id LIMIT 1
        ) p
        WHERE i.ai_assigned AND NOT i.archived AND i.state IN ('triage','backlog','ready')
        AND NOT EXISTS (SELECT 1 FROM cloud_runs r WHERE r.organization_id=i.organization_id AND r.issue_id=i.id AND r.created_at>=i.updated_at)
        AND (SELECT count(*) FROM cloud_runs r WHERE r.organization_id=i.organization_id AND r.project_id=i.project_id
          AND r.state NOT IN ('succeeded','failed','canceled','timed_out'))<${activeTasksPerProject}
        ORDER BY i.updated_at LIMIT ${batchSize}`,
      ),
    );
    let started = 0;
    for (const candidate of candidates.rows) {
      if (this.declined.get(candidate.issue_id) === candidate.revision)
        continue;
      const actor = {
        organizationId: candidate.organization_id,
        userId: candidate.actor_id,
      };
      try {
        await this.database.transaction((sql) =>
          admitRun(sql, actor, randomUUID(), {
            profileId: candidate.profile_id,
            subject: {
              kind: "issue",
              id: candidate.issue_id,
              revision: candidate.revision,
            },
          }),
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        this.declined.set(candidate.issue_id, candidate.revision);
        continue;
      }
      this.declined.delete(candidate.issue_id);
      await this.move(
        candidate.organization_id,
        candidate.actor_id,
        candidate.issue_id,
        "active",
      );
      started++;
    }
    return started;
  }

  private async block(): Promise<number> {
    const failed = await this.database.transaction((sql) =>
      sql.query<{
        organization_id: string;
        actor_id: string;
        issue_id: string;
      }>(
        `SELECT r.organization_id,r.actor_id,r.issue_id FROM cloud_runs r
        JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
        WHERE i.ai_assigned AND i.state='active' AND r.state IN ('failed','timed_out')
        AND r.created_at=(SELECT max(x.created_at) FROM cloud_runs x WHERE x.organization_id=r.organization_id AND x.issue_id=r.issue_id)
        LIMIT ${batchSize}`,
      ),
    );
    for (const run of failed.rows)
      await this.move(
        run.organization_id,
        run.actor_id,
        run.issue_id,
        "blocked",
      );
    return failed.rows.length;
  }
}
