import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  DeliveryEntry,
  DeliveryTaskPurpose,
  IssueDelivery,
} from "../../../lib/cloud-issue-delivery";
import type { AutomationStep } from "../../../lib/cloud-automation-contract";
import { automationMarker } from "../../../lib/git-events";
import type { SettingsCipher } from "../../settings-crypto";
import { isCloudError, teamVisibility } from "../access";
import type { CloudDatabase } from "../database";
import { gitConnection } from "./connections";
import { gitClient } from "./git-client";
import type { CloudGitPullRequests } from "./pull-requests";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const conversationLimit = 5;
const excerptLength = 400;

const reviewDecisions = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  approved: "approved",
  changes_requested: "changes_requested",
  commented: "commented",
} as const;

function excerpt(body: string): string {
  const text = body.replace(automationMarker, "").trim();
  return text.length > excerptLength
    ? `${text.slice(0, excerptLength - 1)}…`
    : text;
}

export class CloudIssueDelivery {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly pullRequests: CloudGitPullRequests,
    private readonly transport: typeof fetch,
  ) {}

  async read(actor: CloudActor, issueId: string): Promise<IssueDelivery> {
    const pullRequests = await this.pullRequests.forIssue(actor, issueId);
    const ids = pullRequests.map((pullRequest) => pullRequest.id);
    const stored = await this.database.transaction(async (sql) => {
      const runs = await sql.query<{
        id: string;
        title: string;
        state: string;
        kind: string;
        purpose: string | null;
        subjectId: string;
        at: string;
      }>(
        `SELECT r.id,r.title,r.state,r.manifest->'subject'->>'kind' AS kind,r.manifest->'subject'->>'purpose' AS purpose,
        r.manifest->'subject'->>'id' AS "subjectId",to_char(r.created_at AT TIME ZONE 'UTC',${timestamp}) AS at
        FROM cloud_runs r
        JOIN cloud_teams t ON t.organization_id=r.organization_id AND t.id=r.team_id
        JOIN cloud_memberships m ON m.organization_id=r.organization_id AND m.user_id=$2
        WHERE r.organization_id=$1 AND ${teamVisibility}
        AND (r.issue_id=$3 OR (r.manifest->'subject'->>'kind'='pull_request' AND r.manifest->'subject'->>'id'=ANY($4::text[])))
        ORDER BY r.created_at LIMIT 100`,
        [actor.organizationId, actor.userId, issueId, ids],
      );
      const automations = await sql.query<{
        id: string;
        automationId: string;
        name: string;
        state: Extract<DeliveryEntry, { kind: "automation" }>["state"];
        steps: AutomationStep[];
        error: string | null;
        pullRequestId: string | null;
        at: string;
      }>(
        `SELECT ar.id,a.id AS "automationId",a.name,ar.state,ar.steps,ar.error,ar.variables->'pullRequest'->>'id' AS "pullRequestId",
        to_char(ar.created_at AT TIME ZONE 'UTC',${timestamp}) AS at
        FROM cloud_automation_runs ar
        JOIN cloud_automations a ON a.organization_id=ar.organization_id AND a.id=ar.automation_id
        JOIN cloud_teams t ON t.organization_id=a.organization_id AND t.id=a.team_id
        JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2
        WHERE ar.organization_id=$1 AND ${teamVisibility}
        AND (ar.issue_id=$3 OR ar.variables->'pullRequest'->>'id'=ANY($4::text[]))
        ORDER BY ar.created_at LIMIT 100`,
        [actor.organizationId, actor.userId, issueId, ids],
      );
      const opened = await sql.query<{ id: string; at: string | null }>(
        `SELECT id,to_char(opened_at AT TIME ZONE 'UTC',${timestamp}) AS at FROM cloud_git_pull_requests WHERE organization_id=$1 AND id=ANY($2::uuid[])`,
        [actor.organizationId, ids],
      );
      return {
        runs: runs.rows,
        automations: automations.rows,
        opened: new Map(opened.rows.map((row) => [row.id, row.at])),
      };
    });
    const entries: DeliveryEntry[] = [];
    for (const run of stored.runs)
      entries.push({
        id: `task-${run.id}`,
        at: run.at,
        kind: "task",
        runId: run.id,
        title: run.title,
        state: run.state,
        purpose:
          run.kind === "pull_request"
            ? (run.purpose as DeliveryTaskPurpose)
            : "implement",
        pullRequestId: run.kind === "pull_request" ? run.subjectId : null,
      });
    for (const run of stored.automations) {
      const step = run.steps.at(-1);
      entries.push({
        id: `automation-${run.id}`,
        at: run.at,
        kind: "automation",
        automationId: run.automationId,
        name: run.name,
        state: run.state,
        detail: run.error ?? step?.detail ?? "",
        link: step?.link ?? null,
        pullRequestId: run.pullRequestId,
      });
    }
    const unavailable: string[] = [];
    for (const pullRequest of pullRequests) {
      const openedAt = stored.opened.get(pullRequest.id);
      if (openedAt)
        entries.push({
          id: `opened-${pullRequest.id}`,
          at: openedAt,
          kind: "opened",
          pullRequestId: pullRequest.id,
        });
      if (pullRequest.state !== "open")
        entries.push({
          id: `${pullRequest.state}-${pullRequest.id}`,
          at: pullRequest.mergedAt ?? pullRequest.updatedAt,
          kind: pullRequest.state === "merged" ? "merged" : "closed",
          pullRequestId: pullRequest.id,
        });
    }
    await Promise.all(
      pullRequests.slice(0, conversationLimit).map(async (pullRequest) => {
        try {
          const connection = await this.database.transaction((sql) =>
            gitConnection(
              sql,
              this.cipher,
              actor.organizationId,
              pullRequest.provider,
            ),
          );
          const conversation = await gitClient(
            connection,
            this.transport,
          ).conversation(pullRequest.repository, pullRequest.number);
          for (const entry of conversation) {
            const automated = entry.body.includes(automationMarker);
            const decision =
              entry.kind === "review" && entry.state
                ? reviewDecisions[entry.state as keyof typeof reviewDecisions]
                : undefined;
            entries.push(
              decision
                ? {
                    id: entry.id,
                    at: entry.createdAt,
                    kind: "review",
                    author: entry.author,
                    decision,
                    body: excerpt(entry.body),
                    url: entry.url,
                    automated,
                    pullRequestId: pullRequest.id,
                  }
                : {
                    id: entry.id,
                    at: entry.createdAt,
                    kind: "comment",
                    author: entry.author,
                    body: excerpt(entry.body),
                    url: entry.url,
                    automated,
                    pullRequestId: pullRequest.id,
                  },
            );
          }
        } catch (error) {
          if (!isCloudError(error)) throw error;
          unavailable.push(`${pullRequest.repository}#${pullRequest.number}`);
        }
      }),
    );
    entries.sort((left, right) => left.at.localeCompare(right.at));
    return {
      pullRequests: pullRequests.map((pullRequest) => ({
        id: pullRequest.id,
        repository: pullRequest.repository,
        number: pullRequest.number,
        title: pullRequest.title,
        stage: pullRequest.stage,
        url: pullRequest.url,
      })),
      entries,
      unavailable,
    };
  }
}
