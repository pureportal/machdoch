import { randomUUID } from "node:crypto";
import type {
  ReviewFinding,
  DeliveryGate,
  DeliveryState,
  RunDelivery,
} from "@machdoch/fleet-protocol/cloud-delivery";
import type { RunManifest } from "@machdoch/fleet-protocol/cloud-execution";
import type { issueStates } from "../../../lib/cloud-contract";

import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import { gitClient, type GitPullRequestRecord } from "../git/git-client";
import { gitConnection, type GitConnectionRecord } from "../git/connections";
import type { StoredRepository } from "../git/events";
import { repositoryAuthorization } from "../git/repository-access";
import type { CloudGitSync } from "../git/sync";
import { pushCandidate } from "./candidate-push";

type IssueState = (typeof issueStates)[number];

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
  manifest: RunManifest;
  baseCommit: string;
  actorId: string;
  identifier: string | null;
}

const deliveryColumns = `kind,state,branch,base_branch AS "baseBranch",head_sha AS "headSha",pull_request_id AS "pullRequestId",
  pull_request_number AS "pullRequestNumber",pull_request_url AS "pullRequestUrl",auto_merge AS "autoMerge",reason,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(merged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "mergedAt"`;

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
        `SELECT kind,organization_id,run_id,issue_id,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,auto_merge,attempts
        FROM cloud_run_deliveries WHERE state IN ('publishing','open','merging') AND next_attempt_at<=clock_timestamp()
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
          WHERE r.state='succeeded' AND r.created_at>clock_timestamp()-interval '7 days'
          AND (r.manifest->'subject'->>'kind' IN ('issue','project') OR r.manifest->'subject'->>'purpose'='check')
          AND NOT EXISTS (SELECT 1 FROM cloud_run_deliveries d WHERE d.organization_id=r.organization_id AND d.run_id=r.id)
          ORDER BY r.created_at LIMIT ${batchSize} FOR UPDATE OF r SKIP LOCKED`,
        )
      ).rows;
      for (const run of runs) {
        if (!run.candidate || !run.base_commit) continue;
        if (run.manifest.subject.kind === "pull_request") {
          await sql.query(
            `INSERT INTO cloud_run_deliveries (organization_id,run_id,kind,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,pull_request_url,auto_merge)
            SELECT $1,$2,'check',$3,'publishing',p.head_ref,p.base_ref,$4,p.id,p.number,p.url,false
            FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.id=$5`,
            [
              run.organization_id,
              run.id,
              run.manifest.profile.repository,
              run.candidate,
              run.manifest.subject.id,
            ],
          );
          continue;
        }
        const review = (
          await sql.query<{ decision: string; gates: DeliveryGate[] }>(
            "SELECT decision,gates FROM cloud_run_reviews WHERE organization_id=$1 AND run_id=$2 AND candidate_commit=$3 ORDER BY created_at DESC LIMIT 1",
            [run.organization_id, run.id, run.candidate],
          )
        ).rows[0];
        const approved =
          review?.decision === "approve" &&
          review.gates.every((gate) => gate.passed);
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
        const reason = !connected
          ? "Add this repository under Settings → Git to publish changes."
          : !review
            ? null
            : review.decision !== "approve"
              ? "The AI review did not approve the change after all rounds."
              : approved
                ? null
                : review.gates
                    .filter((gate) => !gate.passed)
                    .map((gate) => gate.detail)
                    .join(" ");
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
            reason,
          ],
        );
        if (run.issue_id) await this.supersede(sql, run.organization_id, run);
      }
      return runs.length;
    });
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
          `SELECT r.title,r.summary,r.manifest,r.base_commit AS "baseCommit",r.actor_id AS "actorId",i.identifier
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
    } = {},
  ): Promise<void> {
    await this.database.transaction((sql) =>
      sql.query(
        `UPDATE cloud_run_deliveries SET state=$3,reason=CASE WHEN $11 THEN $4 ELSE reason END,attempts=$5,next_attempt_at=clock_timestamp()+$6*interval '1 second',updated_at=clock_timestamp(),
        pull_request_id=COALESCE($7,pull_request_id),pull_request_number=COALESCE($8,pull_request_number),pull_request_url=COALESCE($9,pull_request_url),
        merged_at=CASE WHEN $10 THEN clock_timestamp() ELSE merged_at END
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
        ],
      ),
    );
    delivery.state = state;
  }

  private async moveIssue(
    delivery: StoredDelivery,
    actorId: string,
    category: IssueState,
  ): Promise<void> {
    if (!delivery.issue_id) return;
    try {
      await this.issueChanges.apply(
        { organizationId: delivery.organization_id, userId: actorId },
        randomUUID(),
        {
          issues: [{ id: delivery.issue_id }],
          changes: { statusCategory: category },
        },
      );
    } catch (error) {
      if (!isCloudError(error) || ![404, 409, 422].includes(error.status))
        throw error;
    }
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
      candidateCommit: delivery.head_sha,
      branch: delivery.branch,
    });
    const client = gitClient(connection, this.transport);
    const title =
      `${run.identifier ? `${run.identifier} ` : ""}${run.title}`.slice(0, 250);
    const body = [
      run.summary?.trim() ?? "",
      "---",
      prepared.review
        ? `**AI review:** approved in round ${prepared.review.round}. ${prepared.review.summary}`
        : "",
      ...(prepared.review?.gates.map(gateLine) ?? []),
      `[Open the task](${this.origin}/cloud/tasks/${delivery.run_id})`,
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
    await this.update(delivery, delivery.auto_merge ? "merging" : "open", {
      pullRequest: { id, record },
      retryInSeconds: delivery.auto_merge ? 15 : 120,
    });
    await this.moveIssue(delivery, run.actorId, "review");
  }

  private async report(
    delivery: StoredDelivery,
    repository: StoredRepository,
    connection: GitConnectionRecord,
    run: RunSource,
  ): Promise<void> {
    const evidence = await this.database.transaction(async (sql) => ({
      review: (
        await sql.query<{
          summary: string;
          findings: ReviewFinding[];
          gates: DeliveryGate[];
        }>(
          "SELECT summary,findings,gates FROM cloud_run_reviews WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 1",
          [delivery.organization_id, delivery.run_id],
        )
      ).rows[0],
      checks: (
        await sql.query<{ checks: { name: string; passed: boolean }[] }>(
          "SELECT COALESCE(result->'checks','[]'::jsonb) AS checks FROM cloud_runs WHERE organization_id=$1 AND id=$2",
          [delivery.organization_id, delivery.run_id],
        )
      ).rows[0]!.checks,
    }));
    const blocking =
      evidence.review?.findings.filter(
        (finding) => finding.severity === "blocking",
      ) ?? [];
    const failedChecks = evidence.checks.filter((check) => !check.passed);
    const problems = blocking.length + failedChecks.length;
    const verdict = problems
      ? `${problems} ${problems === 1 ? "problem" : "problems"} found`
      : "No problems found";
    const body = [
      `**Machdoch check: ${verdict}**`,
      run.summary?.trim() ?? "",
      evidence.checks.length
        ? `**Checks:** ${evidence.checks.map((check) => `${check.passed ? "✅" : "❌"} ${check.name}`).join(" · ")}`
        : "",
      evidence.review ? `**AI review:** ${evidence.review.summary}` : "",
      blocking
        .map(
          (finding) =>
            `- ⚠️ **${finding.title}**${finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : ""}: ${finding.detail}`,
        )
        .join("\n"),
      ...(evidence.review?.gates.filter((gate) => !gate.passed).map(gateLine) ??
        []),
      `[Open the check](${this.origin}/cloud/tasks/${delivery.run_id})`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 60_000);
    await gitClient(connection, this.transport).review(
      repository.fullName,
      delivery.pull_request_number!,
      { decision: "comment", body, headSha: delivery.head_sha },
    );
    await this.update(delivery, "reported", { reason: `${verdict}.` });
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
    await this.moveIssue(delivery, run.actorId, "complete");
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
