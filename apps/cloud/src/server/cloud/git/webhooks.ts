import { createHmac, timingSafeEqual } from "node:crypto";
import { isAutomationText, type GitEvent } from "../../../lib/git-events";
import type { GitProvider } from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  gitConnectionByWebhook,
  type GitConnectionRecord,
} from "./connections";
import { gitEvent, queueGitEvents, type StoredRepository } from "./events";
import { gitClient } from "./git-client";
import { parseGitHubWebhook } from "./github-webhooks";
import { parseGitLabWebhook } from "./gitlab-webhooks";
import { eventPullRequest, repositoryColumns, type CloudGitSync } from "./sync";
import type { ParsedWebhook, WebhookActivity } from "./webhook-payloads";

export interface WebhookHeaders {
  event: string;
  delivery: string;
  signature: string;
}

function sameSecret(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verified(
  provider: GitProvider,
  connection: GitConnectionRecord,
  signature: string,
  body: Buffer,
): boolean {
  return provider === "github"
    ? sameSecret(
        signature,
        `sha256=${createHmac("sha256", connection.webhookSecret).update(body).digest("hex")}`,
      )
    : sameSecret(signature, connection.webhookSecret);
}

function written(activity: WebhookActivity): boolean {
  return isAutomationText(
    activity.comment?.body ?? activity.review?.body ?? "",
  );
}

async function activityEvents(
  sql: CloudSql,
  organizationId: string,
  repository: StoredRepository,
  parsed: ParsedWebhook,
): Promise<GitEvent[]> {
  const events: GitEvent[] = [];
  for (const activity of parsed.activities) {
    if (written(activity)) continue;
    const { kind, pullRequestNumber, ...fields } = activity;
    if (pullRequestNumber === null) {
      events.push(
        gitEvent(repository, kind, { ...fields, sender: parsed.sender }),
      );
      continue;
    }
    const pullRequest = (
      await sql.query<{
        id: string;
        number: number;
        title: string;
        url: string;
        author: string | null;
        headRef: string;
        baseRef: string;
        headSha: string;
        draft: boolean;
        issueIds: string[];
      }>(
        `SELECT p.id,p.number,p.title,p.url,p.author,p.head_ref AS "headRef",p.base_ref AS "baseRef",p.head_sha AS "headSha",p.draft,
        COALESCE((SELECT array_agg(l.issue_id) FROM cloud_git_pull_request_issues l WHERE l.organization_id=p.organization_id AND l.pull_request_id=p.id),'{}') AS "issueIds"
        FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.repository_id=$2 AND p.number=$3`,
        [organizationId, repository.id, pullRequestNumber],
      )
    ).rows[0];
    if (!pullRequest) continue;
    events.push(
      gitEvent(repository, kind, {
        ...fields,
        branch: pullRequest.baseRef,
        sender: parsed.sender,
        pullRequest: eventPullRequest(pullRequest.id, pullRequest),
        issueIds: pullRequest.issueIds,
      }),
    );
  }
  return events;
}

export class CloudGitWebhooks {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly sync: CloudGitSync,
    private readonly transport: typeof fetch,
  ) {}

  async receive(
    provider: GitProvider,
    webhookId: string,
    headers: WebhookHeaders,
    body: Buffer,
  ): Promise<void> {
    const connection = await this.database.transaction((sql) =>
      gitConnectionByWebhook(sql, this.cipher, provider, webhookId),
    );
    if (!connection)
      throw new CloudError(404, "not_found", "This webhook is unavailable.");
    if (!verified(provider, connection, headers.signature, body))
      throw new CloudError(401, "git_signature", "The signature is invalid.");
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new CloudError(
        400,
        "invalid_json",
        "The webhook body is not JSON.",
      );
    }
    const parsed =
      provider === "github"
        ? parseGitHubWebhook(headers.event, payload)
        : parseGitLabWebhook(headers.event, payload);
    const repository = await this.database.transaction(async (sql) => {
      const fresh = await sql.query(
        "INSERT INTO cloud_git_deliveries (provider,delivery_id,organization_id,event) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,delivery_id) DO NOTHING RETURNING delivery_id",
        [
          provider,
          headers.delivery,
          connection.organizationId,
          headers.event.slice(0, 60),
        ],
      );
      if (!fresh.rows.length || !parsed) return null;
      const stored = (
        await sql.query<StoredRepository>(
          `SELECT ${repositoryColumns} FROM cloud_git_repositories r WHERE r.organization_id=$1 AND r.provider=$2 AND r.external_id=$3`,
          [connection.organizationId, provider, parsed.repositoryExternalId],
        )
      ).rows[0];
      if (!stored) return null;
      if (parsed.staleSha)
        await sql.query(
          "UPDATE cloud_git_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND repository_id=$2 AND head_sha=$3 AND state='open'",
          [connection.organizationId, stored.id, parsed.staleSha],
        );
      if (parsed.staleNumber)
        await sql.query(
          "UPDATE cloud_git_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND repository_id=$2 AND number=$3 AND state='open'",
          [connection.organizationId, stored.id, parsed.staleNumber],
        );
      return stored;
    });
    if (!repository || !parsed) return;
    const pullRequest =
      parsed.pullRequest ??
      (parsed.fetchPullRequest
        ? await gitClient(connection, this.transport).pullRequest(
            repository.fullName,
            parsed.fetchPullRequest,
          )
        : null);
    if (pullRequest)
      await this.sync.store(connection, repository, pullRequest, {
        sender: parsed.sender,
      });
    if (!parsed.activities.length) return;
    await this.database.transaction(async (sql) =>
      queueGitEvents(
        sql,
        connection,
        await activityEvents(
          sql,
          connection.organizationId,
          repository,
          parsed,
        ),
      ),
    );
  }
}
