import { randomUUID } from "node:crypto";
import type { issueStates } from "../../../lib/cloud-contract";

import { isCloudError } from "../access";
import type { CloudDatabase } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import { admitRun } from "./admission";

type IssueState = (typeof issueStates)[number];

const activeTasksPerProject = 3;
const pullRequestCheckObjective =
  "Check this pull request before it is merged. Install what it needs, build it and run its tests and checks. Read the changed code and look for bugs, regressions, security problems, broken edge cases and missing tests. If it changes a user interface and a browser is available in the sandbox, start the app and inspect the affected screens for visual problems. Do not fix anything; report what you find.";
const pullRequestCheckCriteria =
  "Every problem is reported with the file, the evidence and why it matters. Commands that could not run are reported as not run.";
const batchSize = 10;

export class CloudAutopilot {
  private readonly declined = new Map<string, number>();
  private readonly declinedChecks = new Set<string>();

  constructor(
    private readonly database: CloudDatabase,
    private readonly issueChanges: CloudIssueChanges,
  ) {}

  async tick(): Promise<number> {
    return (
      (await this.start()) +
      (await this.block()) +
      (await this.checkPullRequests())
    );
  }

  private async move(
    organizationId: string,
    userId: string,
    issueId: string,
    category: IssueState,
  ): Promise<void> {
    try {
      await this.issueChanges.apply({ organizationId, userId }, randomUUID(), {
        issues: [{ id: issueId }],
        changes: { statusCategory: category },
      });
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

  private async checkPullRequests(): Promise<number> {
    const candidates = await this.database.transaction((sql) =>
      sql.query<{
        organization_id: string;
        profile_id: string;
        actor_id: string;
        pull_request_id: string;
        head_sha: string;
      }>(
        `SELECT p.organization_id,p.id AS profile_id,p.check_actor_id AS actor_id,pr.id AS pull_request_id,pr.head_sha
        FROM cloud_execution_profiles p
        JOIN cloud_git_repositories r ON r.organization_id=p.organization_id
          AND lower(r.web_url)=lower(regexp_replace(p.definition->>'repository','\\.git$',''))
        JOIN cloud_git_pull_requests pr ON pr.organization_id=p.organization_id AND pr.repository_id=r.id
        WHERE p.enabled AND (p.definition->>'checkPullRequests')::boolean AND p.check_actor_id IS NOT NULL
        AND pr.state='open' AND NOT pr.draft AND pr.head_ref NOT LIKE 'machdoch/%'
        AND NOT EXISTS (SELECT 1 FROM cloud_runs x WHERE x.organization_id=pr.organization_id
          AND x.manifest->'subject'->>'kind'='pull_request' AND x.manifest->'subject'->>'id'=pr.id::text
          AND x.manifest->'subject'->>'headSha'=pr.head_sha)
        AND (SELECT count(*) FROM cloud_runs x WHERE x.organization_id=p.organization_id AND x.project_id=p.project_id
          AND x.state NOT IN ('succeeded','failed','canceled','timed_out'))<${activeTasksPerProject}
        ORDER BY pr.updated_at LIMIT ${batchSize}`,
      ),
    );
    let started = 0;
    for (const candidate of candidates.rows) {
      const key = `${candidate.pull_request_id}:${candidate.head_sha}`;
      if (this.declinedChecks.has(key)) continue;
      try {
        await this.database.transaction((sql) =>
          admitRun(
            sql,
            {
              organizationId: candidate.organization_id,
              userId: candidate.actor_id,
            },
            randomUUID(),
            {
              profileId: candidate.profile_id,
              subject: {
                kind: "pull_request",
                purpose: "check",
                id: candidate.pull_request_id,
                headSha: candidate.head_sha,
                objective: pullRequestCheckObjective,
                acceptanceCriteria: pullRequestCheckCriteria,
              },
            },
          ),
        );
        started++;
      } catch (error) {
        if (!isCloudError(error)) throw error;
        this.declinedChecks.add(key);
      }
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
