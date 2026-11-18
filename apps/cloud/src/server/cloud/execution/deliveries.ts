import { randomUUID } from "node:crypto";
import type {
  ReviewFinding,
  DeliveryGate,
  DeliveryState,
  RunDelivery,
} from "@machdoch/fleet-protocol/cloud-delivery";
import type { RunManifest } from "@machdoch/fleet-protocol/cloud-execution";
import type { GitEventPullRequest } from "../../../lib/git-events";

import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import type { IssueChangeSet } from "../../../lib/cloud-issue-changes-contract";
import { completeTaskList } from "../../../lib/issue-text";
import {
  gitClient,
  type GitCommitStatusState,
  type GitPullRequestRecord,
} from "../git/git-client";
import { gitConnection, type GitConnectionRecord } from "../git/connections";
import { gitEvent, queueGitEvents, type StoredRepository } from "../git/events";
import { repositoryAuthorization } from "../git/repository-access";
import type { CloudGitSync } from "../git/sync";
import { pushCandidate } from "./candidate-push";
import { sandboxStatusContext } from "./pull-request-tasks";

const batchSize = 5;
const maximumAttempts = 6;
const checksWaitAttempts = 240;

interface StoredDelivery extends Record<string, unknown> {
  kind: "change" | "check";
  organization_id: string;
  run_id: string;
  issue_id: string | null;
  repository: string;
  state: DeliveryState;
  branch: string;
  base_branch: string;
  head_sha: string;
  pull_request_id: string | null;
  pull_request_number: number | null;
  auto_merge: boolean;
  attempts: number;
}

interface RunSource extends Record<string, unknown> {
  title: string;
  summary: string | null;
  state: string;
  manifest: RunManifest;
  baseCommit: string;
  actorId: string;
  identifier: string | null;
}

interface CheckEvidence {
  summary: string | null;
  review: {
    summary: string;
    findings: ReviewFinding[];
    gates: DeliveryGate[];
  } | null;
  checks: { name: string; passed: boolean }[];
}

const deliveryColumns = `kind,state,branch,base_branch AS "baseBranch",head_sha AS "headSha",pull_request_id AS "pullRequestId",
  pull_request_number AS "pullRequestNumber",pull_request_url AS "pullRequestUrl",auto_merge AS "autoMerge",problems,reason,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(merged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "mergedAt"`;

const storedColumns = `kind,organization_id,run_id,issue_id,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,auto_merge,attempts`;

export async function readRunDelivery(
  sql: CloudSql,
  organizationId: string,
  runId: string,
): Promise<RunDelivery | null> {
  return (
    (
      await sql.query<RunDelivery & Record<string, unknown>>(
        `SELECT ${deliveryColumns} FROM cloud_run_deliveries WHERE organization_id=$1 AND run_id=$2`,
        [organizationId, runId],
      )
    ).rows[0] ?? null
  );
}

function branchName(title: string, identifier: string | null, runId: string) {
  const slug = `${identifier ?? ""} ${title}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `machdoch/${slug || "change"}-${runId.slice(0, 8)}`;
}

function gateLine(gate: DeliveryGate): string {
  const names: Record<DeliveryGate["id"], string> = {
    checks: "Checks",
    tests_intact: "Tests intact",
    protected_paths: "Sensitive areas",
    change_size: "Change size",
  };
  return `- ${gate.passed ? "✅" : "⚠️"} **${names[gate.id]}:** ${gate.detail}`;
}

function findingLine(finding: ReviewFinding): string {
  const location = finding.file
    ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\``
    : "";
  return `- ⚠️ **${finding.title}**${location}: ${finding.detail}`;
}

function checkLines(evidence: CheckEvidence): string[] {
  return [
    evidence.checks.length
      ? `**Checks:** ${evidence.checks.map((check) => `${check.passed ? "✅" : "❌"} ${check.name}`).join(" · ")}`
      : "",
    evidence.review ? `**AI review:** ${evidence.review.summary}` : "",
    evidence.review?.findings
      .filter((finding) => finding.severity === "blocking")
      .map(findingLine)
      .join("\n") ?? "",
    ...(evidence.review?.gates.filter((gate) => !gate.passed).map(gateLine) ??
      []),
  ];
}

function problemCount(evidence: CheckEvidence): number {
  const blocking =
    evidence.review?.findings.filter(
      (finding) => finding.severity === "blocking",
    ).length ?? 0;
  return blocking + evidence.checks.filter((check) => !check.passed).length;
}

function problemsLabel(problems: number): string {
  return `${problems} ${problems === 1 ? "problem" : "problems"}`;
}

async function readCheckEvidence(
  sql: CloudSql,
  organizationId: string,
  runId: string,
): Promise<CheckEvidence> {
  const run = (
    await sql.query<{
      summary: string | null;
      checks: { name: string; passed: boolean }[];
    }>(
      "SELECT summary,COALESCE(result->'checks','[]'::jsonb) AS checks FROM cloud_runs WHERE organization_id=$1 AND id=$2",
      [organizationId, runId],
    )
  ).rows[0]!;
  const review =
    (
      await sql.query<NonNullable<CheckEvidence["review"]>>(
        "SELECT summary,findings,gates FROM cloud_run_reviews WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 1",
        [organizationId, runId],
      )
    ).rows[0] ?? null;
  return { summary: run.summary, review, checks: run.checks };
}

async function approvedCandidate(
  sql: CloudSql,
  organizationId: string,
  runId: string,
  candidate: string,
): Promise<{ approved: boolean; reason: string | null }> {
  const review = (
    await sql.query<{ decision: string; gates: DeliveryGate[] }>(
      "SELECT decision,gates FROM cloud_run_reviews WHERE organization_id=$1 AND run_id=$2 AND candidate_commit=$3 ORDER BY created_at DESC LIMIT 1",
      [organizationId, runId, candidate],
    )
  ).rows[0];
  if (!review) return { approved: false, reason: null };
  if (review.decision !== "approve")
    return {
      approved: false,
      reason: "The AI review did not approve the change after all rounds.",
    };
  const failed = review.gates.filter((gate) => !gate.passed);
  return failed.length
    ? { approved: false, reason: failed.map((gate) => gate.detail).join(" ") }
    : { approved: true, reason: null };
}

export class CloudDeliveries {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
    private readonly sync: CloudGitSync,
    private readonly issueChanges: CloudIssueChanges,
    private readonly origin: string,
    private readonly cacheDirectory: string,
    private readonly push: typeof pushCandidate = pushCandidate,
  ) {}

  async tick(): Promise<number> {
    let processed = (await this.begin()) + (await this.cleanup());
    const due = await this.database.transaction((sql) =>
      sql.query<StoredDelivery>(
        `SELECT ${storedColumns} FROM cloud_run_deliveries WHERE state IN ('publishing','open','merging') AND next_attempt_at<=clock_timestamp()
        ORDER BY next_attempt_at LIMIT ${batchSize}`,
      ),
    );
    for (const delivery of due.rows) {
      await this.advance(delivery);
      processed++;
    }
    return processed;
  }

  private async begin(): Promise<number> {
    return this.database.transaction(async (sql) => {
      const runs = (
        await sql.query<{
          organization_id: string;
          id: string;
          issue_id: string | null;
          manifest: RunManifest;
          base_commit: string | null;
          candidate: string | null;
        }>(
          `SELECT r.organization_id,r.id,r.issue_id,r.manifest,r.base_commit,r.result->>'candidateCommit' AS candidate FROM cloud_runs r
          WHERE r.created_at>clock_timestamp()-interval '7 days'
          AND ((r.state='succeeded' AND (r.manifest->'subject'->>'kind' IN ('issue','project') OR r.manifest->'subject'->>'purpose' IN ('fix','resolve')))
            OR (r.state IN ('succeeded','failed','timed_out','canceled') AND r.manifest->'subject'->>'purpose'='check'))
          AND NOT EXISTS (SELECT 1 FROM cloud_run_deliveries d WHERE d.organization_id=r.organization_id AND d.run_id=r.id)
          ORDER BY r.created_at LIMIT ${batchSize} FOR UPDATE OF r SKIP LOCKED`,
        )
      ).rows;
      for (const run of runs) {
        if (run.manifest.subject.kind === "pull_request") {
          if (run.manifest.subject.purpose === "check")
            await this.beginCheck(sql, run);
          else if (run.candidate) await this.beginFix(sql, run);
          continue;
        }
        if (!run.candidate || !run.base_commit) continue;
        const { approved, reason: reviewReason } = await approvedCandidate(
          sql,
          run.organization_id,
          run.id,
          run.candidate,
        );
        const connected = (
          await sql.query<{ default_branch: string }>(
            "SELECT default_branch FROM cloud_git_repositories WHERE organization_id=$1 AND lower(web_url)=lower(regexp_replace($2,'\\.git$',''))",
            [run.organization_id, run.manifest.profile.repository],
          )
        ).rows[0];
        const identifier = run.issue_id
          ? ((
              await sql.query<{ identifier: string }>(
                "SELECT identifier FROM cloud_issues WHERE organization_id=$1 AND id=$2",
                [run.organization_id, run.issue_id],
              )
            ).rows[0]?.identifier ?? null)
          : null;
        await sql.query(
          `INSERT INTO cloud_run_deliveries (organization_id,run_id,issue_id,repository,state,branch,base_branch,head_sha,auto_merge,reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            run.organization_id,
            run.id,
            run.issue_id,
            run.manifest.profile.repository,
            connected ? "publishing" : "needs_person",
            branchName(run.manifest.title, identifier, run.id),
            run.manifest.branch ?? connected?.default_branch ?? "main",
            run.candidate,
            approved && run.manifest.profile.autopilot,
            connected
              ? reviewReason
              : "Add this repository under Settings → Git to publish changes.",
          ],
        );
        if (run.issue_id) await this.supersede(sql, run.organization_id, run);
      }
      return runs.length;
    });
  }

  private async beginCheck(
    sql: CloudSql,
    run: { organization_id: string; id: string; manifest: RunManifest },
  ): Promise<void> {
    if (run.manifest.subject.kind !== "pull_request") return;
    await sql.query(
      `INSERT INTO cloud_run_deliveries (organization_id,run_id,kind,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,pull_request_url,auto_merge)
      SELECT $1,$2,'check',$3,'publishing',p.head_ref,p.base_ref,$4,p.id,p.number,p.url,false
      FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.id=$5`,
      [
        run.organization_id,
        run.id,
        run.manifest.profile.repository,
        run.manifest.subject.headSha,
        run.manifest.subject.id,
      ],
    );
  }

  private async beginFix(
    sql: CloudSql,
    run: {
      organization_id: string;
      id: string;
      manifest: RunManifest;
      candidate: string | null;
    },
  ): Promise<void> {
    if (run.manifest.subject.kind !== "pull_request" || !run.candidate) return;
    const pullRequestId = run.manifest.subject.id;
    const { approved, reason } = await approvedCandidate(
      sql,
      run.organization_id,
      run.id,
      run.candidate,
    );
    const previous = (
      await sql.query<{ issue_id: string | null }>(
        `SELECT issue_id FROM cloud_run_deliveries WHERE organization_id=$1 AND pull_request_id=$2 AND kind='change' AND issue_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
        [run.organization_id, pullRequestId],
      )
    ).rows[0];
    await sql.query(
      `INSERT INTO cloud_run_deliveries (organization_id,run_id,issue_id,kind,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,pull_request_url,auto_merge,reason)
      SELECT $1,$2,$3,'change',$4,'publishing',p.head_ref,p.base_ref,$5,p.id,p.number,p.url,$6,$7
      FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.id=$8`,
      [
        run.organization_id,
        run.id,
        previous?.issue_id ?? null,
        run.manifest.profile.repository,
        run.candidate,
        approved && run.manifest.profile.autopilot,
        reason,
        pullRequestId,
      ],
    );
    await sql.query(
      `UPDATE cloud_run_deliveries SET state='closed',reason='A newer task replaced this change.',updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()
      WHERE organization_id=$1 AND pull_request_id=$2 AND kind='change' AND run_id<>$3 AND state IN ('publishing','open','merging','needs_person','failed')`,
      [run.organization_id, pullRequestId, run.id],
    );
  }

  private async supersede(
    sql: CloudSql,
    organizationId: string,
    run: { id: string; issue_id: string | null },
  ): Promise<void> {
    await sql.query(
      `UPDATE cloud_run_deliveries SET state='closed',reason='A newer task replaced this change.',updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()
      WHERE organization_id=$1 AND issue_id=$2 AND run_id<>$3 AND state IN ('publishing','needs_person','failed')`,
      [organizationId, run.issue_id, run.id],
    );
  }

  private async context(delivery: StoredDelivery) {
    return this.database.transaction(async (sql) => {
      const repository = (
        await sql.query<StoredRepository>(
          `SELECT id,provider,full_name AS "fullName",default_branch AS "defaultBranch",web_url AS "webUrl"
          FROM cloud_git_repositories WHERE organization_id=$1 AND lower(web_url)=lower(regexp_replace($2,'\\.git$',''))`,
          [delivery.organization_id, delivery.repository],
        )
      ).rows[0];
      if (!repository)
        throw new CloudError(
          409,
          "repository_unconnected",
          "Add this repository under Settings → Git to publish changes.",
        );
      const connection = await gitConnection(
        sql,
        this.cipher,
        delivery.organization_id,
        repository.provider,
      );
      const run = (
        await sql.query<RunSource>(
          `SELECT r.title,r.summary,r.state,r.manifest,r.base_commit AS "baseCommit",r.actor_id AS "actorId",i.identifier
          FROM cloud_runs r LEFT JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
          WHERE r.organization_id=$1 AND r.id=$2`,
          [delivery.organization_id, delivery.run_id],
        )
      ).rows[0]!;
      return { repository, connection, run };
    });
  }

  private async update(
    delivery: StoredDelivery,
    state: DeliveryState,
    fields: {
      reason?: string | null;
      retryInSeconds?: number;
      pullRequest?: { id: string; record: GitPullRequestRecord };
      merged?: boolean;
      attempts?: number;
      problems?: number;
    } = {},
  ): Promise<void> {
    await this.database.transaction((sql) =>
      sql.query(
        `UPDATE cloud_run_deliveries SET state=$3,reason=CASE WHEN $11 THEN $4 ELSE reason END,attempts=$5,next_attempt_at=clock_timestamp()+$6*interval '1 second',updated_at=clock_timestamp(),
        pull_request_id=COALESCE($7,pull_request_id),pull_request_number=COALESCE($8,pull_request_number),pull_request_url=COALESCE($9,pull_request_url),
        merged_at=CASE WHEN $10 THEN clock_timestamp() ELSE merged_at END,problems=COALESCE($12,problems)
        WHERE organization_id=$1 AND run_id=$2`,
        [
          delivery.organization_id,
          delivery.run_id,
          state,
          fields.reason ?? null,
          fields.attempts ?? 0,
          fields.retryInSeconds ?? 0,
          fields.pullRequest?.id ?? null,
          fields.pullRequest?.record.number ?? null,
          fields.pullRequest?.record.url ?? null,
          fields.merged ?? false,
          fields.reason !== undefined,
          fields.problems ?? null,
        ],
      ),
    );
    delivery.state = state;
  }

  private async changeIssue(
    delivery: StoredDelivery,
    actorId: string,
    changes: IssueChangeSet,
    revision?: number,
  ): Promise<void> {
    if (!delivery.issue_id) return;
    try {
      await this.issueChanges.apply(
        {
          organizationId: delivery.organization_id,
          userId: actorId,
          automation: "Machdoch AI",
        },
        randomUUID(),
        { issues: [{ id: delivery.issue_id, revision }], changes },
      );
    } catch (error) {
      if (!isCloudError(error) || ![404, 409, 422].includes(error.status))
        throw error;
    }
  }

  private async confirmCriteria(
    delivery: StoredDelivery,
    run: RunSource,
  ): Promise<void> {
    if (!delivery.issue_id || !delivery.pull_request_id) return;
    const issue = (
      await this.database.transaction((sql) =>
        sql.query<{
          criteria: string;
          revision: number;
          reviewed: string;
        }>(
          `SELECT i.acceptance_criteria AS criteria,i.revision,r.manifest->>'acceptanceCriteria' AS reviewed
          FROM cloud_issues i
          JOIN cloud_run_deliveries d ON d.organization_id=i.organization_id AND d.issue_id=i.id AND d.pull_request_id=$3
          JOIN cloud_runs r ON r.organization_id=d.organization_id AND r.id=d.run_id AND r.manifest->'subject'->>'kind'='issue'
          WHERE i.organization_id=$1 AND i.id=$2
          AND (SELECT v.decision FROM cloud_run_reviews v WHERE v.organization_id=r.organization_id AND v.run_id=r.id ORDER BY v.round DESC LIMIT 1)='approve'
          ORDER BY r.created_at DESC LIMIT 1`,
          [
            delivery.organization_id,
            delivery.issue_id,
            delivery.pull_request_id,
          ],
        ),
      )
    ).rows[0];
    if (!issue || issue.criteria.trim() !== issue.reviewed.trim()) return;
    const confirmed = completeTaskList(issue.criteria);
    if (confirmed !== issue.criteria)
      await this.changeIssue(
        delivery,
        run.actorId,
        { acceptanceCriteria: confirmed },
        issue.revision,
      );
  }

  private async advance(delivery: StoredDelivery): Promise<void> {
    try {
      const { repository, connection, run } = await this.context(delivery);
      if (delivery.state === "publishing")
        return delivery.kind === "check"
          ? await this.report(delivery, repository, connection, run)
          : await this.publish(delivery, repository, connection, run);
      const client = gitClient(connection, this.transport);
      const fresh = await client.pullRequest(
        repository.fullName,
        delivery.pull_request_number!,
      );
      await this.sync.store(connection, repository, fresh);
      if (fresh.state === "merged") return await this.merged(delivery, run);
      if (fresh.state === "closed")
        return await this.update(delivery, "closed", {
          reason: "The pull request was closed.",
        });
      if (delivery.state === "open")
        return await this.update(delivery, "open", { retryInSeconds: 120 });
      if (fresh.headSha !== delivery.head_sha)
        return await this.update(delivery, "needs_person", {
          reason: "New commits were pushed to the branch after the AI review.",
        });
      if (fresh.mergeable === false)
        return await this.update(delivery, "needs_person", {
          reason: `The change conflicts with ${delivery.base_branch}.`,
        });
      const pending = await this.pendingWork(delivery);
      if (pending)
        return await this.update(delivery, "merging", {
          reason: pending,
          attempts: delivery.attempts + 1,
          retryInSeconds: 15,
        });
      const checks = await client.checks(
        repository.fullName,
        fresh.number,
        fresh.headSha,
      );
      if (checks.conclusion === "failure")
        return await this.update(delivery, "needs_person", {
          reason: "Repository checks failed on the pull request.",
        });
      if (checks.conclusion === "pending" || fresh.mergeable === null) {
        if (delivery.attempts >= checksWaitAttempts)
          return await this.update(delivery, "needs_person", {
            reason: "Repository checks did not finish within four hours.",
          });
        return await this.update(delivery, "merging", {
          reason: "Waiting for repository checks.",
          attempts: delivery.attempts + 1,
          retryInSeconds: 60,
        });
      }
      await client.merge(repository.fullName, fresh.number, {
        method: client.mergeMethods.includes("squash")
          ? "squash"
          : client.mergeMethods[0]!,
        headSha: delivery.head_sha,
      });
      await this.sync.store(
        connection,
        repository,
        await client.pullRequest(repository.fullName, fresh.number),
      );
      await this.removeBranch(connection, repository, delivery.branch);
      await this.merged(delivery, run);
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Publishing failed.";
      if (isCloudError(error) && error.code === "repository_unconnected")
        return this.update(delivery, "needs_person", { reason: error.message });
      if (attempts >= maximumAttempts && delivery.state === "publishing")
        return this.update(delivery, "failed", { reason: message, attempts });
      return this.update(delivery, delivery.state, {
        reason: message,
        attempts,
        retryInSeconds: Math.min(1800, 30 * 2 ** attempts),
      });
    }
  }

  private async publish(
    delivery: StoredDelivery,
    repository: StoredRepository,
    connection: GitConnectionRecord,
    run: RunSource,
  ): Promise<void> {
    const prepared = await this.database.transaction(async (sql) => ({
      authorization: await repositoryAuthorization(
        sql,
        this.cipher,
        delivery.organization_id,
        delivery.repository,
      ),
      bundle: await this.bundle(sql, delivery),
      review: (
        await sql.query<{
          round: number;
          summary: string;
          gates: DeliveryGate[];
        }>(
          "SELECT round,summary,gates FROM cloud_run_reviews WHERE organization_id=$1 AND run_id=$2 AND candidate_commit=$3 ORDER BY created_at DESC LIMIT 1",
          [delivery.organization_id, delivery.run_id, delivery.head_sha],
        )
      ).rows[0],
      existing: (
        await sql.query<{ number: number }>(
          "SELECT number FROM cloud_git_pull_requests WHERE organization_id=$1 AND repository_id=$2 AND head_ref=$3 AND state='open' LIMIT 1",
          [delivery.organization_id, repository.id, delivery.branch],
        )
      ).rows[0],
    }));
    await this.push({
      cacheDirectory: this.cacheDirectory,
      organizationId: delivery.organization_id,
      remote: `${delivery.repository.replace(/\.git$/, "")}.git`,
      authorization: prepared.authorization,
      bundle: prepared.bundle,
      baseCommit: run.baseCommit,
      ...(run.manifest.subject.kind === "pull_request" &&
      run.manifest.subject.base
        ? { mergeParent: run.manifest.subject.base.sha }
        : {}),
      candidateCommit: delivery.head_sha,
      branch: delivery.branch,
    });
    const client = gitClient(connection, this.transport);
    const title =
      `${run.identifier ? `${run.identifier} ` : ""}${run.title}`.slice(0, 250);
    const review = prepared.review
      ? `**AI review:** approved in round ${prepared.review.round}. ${prepared.review.summary}`
      : "";
    const taskLink = `[Open the task](${this.origin}/cloud/tasks/${delivery.run_id})`;
    const body = [
      run.summary?.trim() ?? "",
      "---",
      review,
      ...(prepared.review?.gates.map(gateLine) ?? []),
      taskLink,
      run.identifier ? `Closes ${run.identifier}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 60_000);
    const record = prepared.existing
      ? await client.pullRequest(repository.fullName, prepared.existing.number)
      : await client.createPullRequest(repository.fullName, {
          title,
          body,
          head: delivery.branch,
          base: delivery.base_branch,
        });
    const id = await this.sync.store(connection, repository, record);
    if (prepared.existing && run.manifest.subject.kind === "pull_request")
      await client.comment(
        repository.fullName,
        record.number,
        [
          `**Machdoch ${run.manifest.subject.purpose === "resolve" ? "conflict resolution" : "fix"}:** ${run.summary?.trim() || "Pushed a change."}`,
          review,
          taskLink,
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 60_000),
      );
    await this.update(delivery, delivery.auto_merge ? "merging" : "open", {
      pullRequest: { id, record },
      retryInSeconds: delivery.auto_merge ? 15 : 120,
    });
    await this.changeIssue(delivery, run.actorId, { statusCategory: "review" });
  }

  private async report(
    delivery: StoredDelivery,
    repository: StoredRepository,
    connection: GitConnectionRecord,
    run: RunSource,
  ): Promise<void> {
    const client = gitClient(connection, this.transport);
    const link = `${this.origin}/cloud/tasks/${delivery.run_id}`;
    const status = (state: GitCommitStatusState, description: string) =>
      client.commitStatus(repository.fullName, delivery.head_sha, {
        state,
        context: sandboxStatusContext,
        description,
        targetUrl: link,
      });
    if (run.state !== "succeeded") {
      const reason =
        run.state === "timed_out"
          ? "The sandbox check ran out of time."
          : `The sandbox check ${run.state}.`;
      await status("error", reason);
      return this.update(delivery, "failed", { reason });
    }
    const evidence = await this.database.transaction((sql) =>
      readCheckEvidence(sql, delivery.organization_id, delivery.run_id),
    );
    const problems = problemCount(evidence);
    const verdict = problems
      ? `${problemsLabel(problems)} found`
      : "No problems found";
    const report = [
      `**Machdoch check: ${verdict}**`,
      run.summary?.trim() ?? "",
      ...checkLines(evidence),
      `[Open the check](${link})`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 60_000);
    await client.review(repository.fullName, delivery.pull_request_number!, {
      decision: "comment",
      body: report,
      headSha: delivery.head_sha,
    });
    await status(problems ? "failure" : "success", verdict);
    await this.update(delivery, "reported", {
      reason: `${verdict}.`,
      problems,
    });
    await this.database.transaction(async (sql) => {
      const pullRequest = (
        await sql.query<GitEventPullRequest & Record<string, unknown>>(
          `SELECT id,number,title,url,author,head_ref AS "headRef",base_ref AS "baseRef",head_sha AS "headSha",draft
          FROM cloud_git_pull_requests WHERE organization_id=$1 AND id=$2`,
          [delivery.organization_id, delivery.pull_request_id],
        )
      ).rows[0];
      if (!pullRequest) return;
      const issueIds = (
        await sql.query<{ issue_id: string }>(
          "SELECT issue_id FROM cloud_git_pull_request_issues WHERE organization_id=$1 AND pull_request_id=$2",
          [delivery.organization_id, pullRequest.id],
        )
      ).rows.map((row) => row.issue_id);
      await queueGitEvents(sql, connection, [
        gitEvent(
          repository,
          problems ? "sandbox_check_failed" : "sandbox_check_passed",
          {
            branch: pullRequest.baseRef,
            pullRequest: { ...pullRequest, headSha: delivery.head_sha },
            check: {
              runId: delivery.run_id,
              problems,
              summary: evidence.review?.summary ?? verdict,
              report,
            },
            issueIds,
          },
        ),
      ]);
    });
  }

  private async pendingWork(delivery: StoredDelivery): Promise<string | null> {
    return this.database.transaction(async (sql) => {
      const automations = await sql.query(
        `SELECT 1 FROM cloud_automation_events WHERE organization_id=$1 AND event->'git'->'pullRequest'->>'id'=$2
        UNION ALL
        SELECT 1 FROM cloud_automation_runs WHERE organization_id=$1 AND state IN ('queued','running','waiting') AND variables->'pullRequest'->>'id'=$2
        LIMIT 1`,
        [delivery.organization_id, delivery.pull_request_id],
      );
      if (automations.rows.length) return "Waiting for automations.";
      const tasks = await sql.query(
        `SELECT 1 FROM cloud_runs WHERE organization_id=$1 AND id<>$3 AND state NOT IN ('succeeded','failed','canceled','timed_out')
        AND manifest->'subject'->>'kind'='pull_request' AND manifest->'subject'->>'id'=$2 AND manifest->'subject'->>'purpose' IN ('fix','resolve') LIMIT 1`,
        [delivery.organization_id, delivery.pull_request_id, delivery.run_id],
      );
      return tasks.rows.length ? "Waiting for the fix task." : null;
    });
  }

  private async bundle(
    sql: CloudSql,
    delivery: StoredDelivery,
  ): Promise<Buffer> {
    const artifact = (
      await sql.query<{ id: string; byte_length: number }>(
        "SELECT id,byte_length FROM cloud_run_artifacts WHERE organization_id=$1 AND run_id=$2 AND kind='candidate' AND candidate_commit=$3 AND state='ready' ORDER BY created_at DESC LIMIT 1",
        [delivery.organization_id, delivery.run_id, delivery.head_sha],
      )
    ).rows[0];
    if (!artifact)
      throw new CloudError(
        409,
        "candidate_unavailable",
        "The verified change is no longer stored.",
      );
    const bytes = Buffer.concat(
      (
        await sql.query<{ bytes: Uint8Array }>(
          "SELECT bytes FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2 ORDER BY offset_bytes",
          [delivery.organization_id, artifact.id],
        )
      ).rows.map((row) => row.bytes),
    );
    if (bytes.byteLength !== artifact.byte_length)
      throw new CloudError(
        409,
        "candidate_unavailable",
        "The verified change is incomplete.",
      );
    return bytes;
  }

  private async removeBranch(
    connection: GitConnectionRecord,
    repository: StoredRepository,
    branch: string,
  ): Promise<void> {
    try {
      await gitClient(connection, this.transport).deleteBranch(
        repository.fullName,
        branch,
      );
    } catch (error) {
      if (!isCloudError(error) || ![404, 409, 422].includes(error.status))
        throw error;
    }
  }

  private async merged(
    delivery: StoredDelivery,
    run: RunSource,
  ): Promise<void> {
    await this.update(delivery, "merged", { merged: true });
    await this.changeIssue(delivery, run.actorId, {
      statusCategory: "complete",
    });
    await this.confirmCriteria(delivery, run);
  }

  private async cleanup(): Promise<number> {
    const stale = await this.database.transaction((sql) =>
      sql.query<StoredDelivery>(
        `SELECT d.kind,d.organization_id,d.run_id,d.issue_id,d.repository,d.state,d.branch,d.base_branch,d.head_sha,d.pull_request_id,d.pull_request_number,d.auto_merge,d.attempts
        FROM cloud_run_deliveries d JOIN cloud_issues i ON i.organization_id=d.organization_id AND i.id=d.issue_id
        WHERE d.state IN ('open','merging','needs_person','failed') AND (i.state IN ('complete','canceled') OR i.archived) AND d.next_attempt_at<=clock_timestamp()
        ORDER BY d.updated_at LIMIT ${batchSize}`,
      ),
    );
    for (const delivery of stale.rows) {
      if (!delivery.pull_request_number) {
        await this.update(delivery, "closed", {
          reason: "The issue was closed before the change was published.",
        });
        continue;
      }
      try {
        const { repository, connection, run } = await this.context(delivery);
        const client = gitClient(connection, this.transport);
        const fresh = await client.pullRequest(
          repository.fullName,
          delivery.pull_request_number,
        );
        if (fresh.state === "merged") {
          await this.merged(delivery, run);
          continue;
        }
        if (fresh.state === "open")
          await client.closePullRequest(repository.fullName, fresh.number);
        await this.sync.store(
          connection,
          repository,
          await client.pullRequest(repository.fullName, fresh.number),
        );
        await this.removeBranch(connection, repository, delivery.branch);
        await this.update(delivery, "closed", {
          reason:
            "The issue was closed, so its pull request and branch were removed.",
        });
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.update(delivery, delivery.state, {
          reason: error.message,
          attempts: delivery.attempts + 1,
          retryInSeconds: Math.min(1800, 30 * 2 ** (delivery.attempts + 1)),
        });
      }
    }
    return stale.rows.length;
  }
}
