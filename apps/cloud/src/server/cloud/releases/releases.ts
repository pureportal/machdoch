import { randomUUID } from "node:crypto";
import type { CloudActor, CloudRole } from "../../../lib/cloud-contract";
import type {
  CloudRelease,
  CloudReleaseSummary,
  PostStateChange,
  ReleaseLaunch,
  ReleaseLaunchResult,
  ProductInput,
  ReleaseInput,
  ReleaseItem,
  ReleaseJob,
  ReleasePost,
  ReleaseUpdate,
} from "../../../lib/cloud-release-contract";
import { releaseStatus } from "../../../lib/release-posts";
import {
  checkRevision,
  CloudError,
  command,
  isCloudError,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readProduct } from "./products";
import { derivedCommandId } from "../command-ids";
import { queueReleaseAutomations } from "../automation/release-automations";

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const maximumItems = 200;

export const postColumns = `p.id,p.release_id AS "releaseId",p.channel_id AS "channelId",c.kind AS "channelKind",c.definition->>'name' AS "channelName",
  p.state,p.title,p.body,p.media_ids AS "mediaIds",p.link,${timestamp("p.scheduled_at")} AS "scheduledAt",ua.name AS "approvedBy",
  ${timestamp("p.published_at")} AS "publishedAt",p.error,p.revision,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('target',d.target,'state',d.state,'url',d.url,'error',d.error,'completedAt',${timestamp("d.completed_at")}) ORDER BY d.target)
    FROM cloud_release_deliveries d WHERE d.organization_id=p.organization_id AND d.post_id=p.id),'[]'::jsonb) AS deliveries`;
export const postFrom = `cloud_release_posts p JOIN cloud_product_channels c ON c.organization_id=p.organization_id AND c.id=p.channel_id
  LEFT JOIN cloud_users ua ON ua.id=p.approved_by`;

interface ReleaseRow {
  id: string;
  productId: string;
  productDefinition: ProductInput;
  version: string;
  name: string;
  summary: string;
  notes: string;
  highlights: CloudRelease["highlights"];
  since: string | null;
  targetDate: string | null;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const releaseColumns = `r.id,r.product_id AS "productId",pr.definition AS "productDefinition",r.version,r.name,r.summary,r.notes,r.highlights,
  to_char(r.since,'YYYY-MM-DD') AS since,to_char(r.target_date,'YYYY-MM-DD') AS "targetDate",r.revision,r.archived,
  ${timestamp("r.created_at")} AS "createdAt",${timestamp("r.updated_at")} AS "updatedAt"`;
const releaseFrom = `cloud_releases r JOIN cloud_products pr ON pr.organization_id=r.organization_id AND pr.id=r.product_id`;

export async function readReleaseRow(
  sql: CloudSql,
  organizationId: string,
  id: string,
  lock = false,
): Promise<ReleaseRow> {
  const row = (
    await sql.query<ReleaseRow & Record<string, unknown>>(
      `SELECT ${releaseColumns} FROM ${releaseFrom} WHERE r.organization_id=$1 AND r.id=$2${lock ? " FOR UPDATE OF r" : ""}`,
      [organizationId, id],
    )
  ).rows[0];
  if (!row) throw new CloudError(404, "not_found", "Release is unavailable.");
  return row;
}

export async function readPosts(
  sql: CloudSql,
  organizationId: string,
  releaseId: string,
): Promise<ReleasePost[]> {
  return (
    await sql.query<ReleasePost & Record<string, unknown>>(
      `SELECT ${postColumns} FROM ${postFrom} WHERE p.organization_id=$1 AND p.release_id=$2 ORDER BY c.position,c.id`,
      [organizationId, releaseId],
    )
  ).rows;
}

export async function ensurePosts(
  sql: CloudSql,
  organizationId: string,
  release: { id: string; productId: string },
): Promise<void> {
  await sql.query(
    `INSERT INTO cloud_release_posts (organization_id,id,release_id,channel_id)
    SELECT c.organization_id,gen_random_uuid(),$2,c.id FROM cloud_product_channels c
    WHERE c.organization_id=$1 AND c.product_id=$3 AND (c.definition->>'enabled')::boolean
    ON CONFLICT (organization_id,release_id,channel_id) DO NOTHING`,
    [organizationId, release.id, release.productId],
  );
}

async function collectItems(
  sql: CloudSql,
  organizationId: string,
  release: { id: string; since: string | null },
  product: ProductInput,
): Promise<void> {
  if (!product.teamIds.length) return;
  await sql.query(
    `INSERT INTO cloud_release_items (organization_id,release_id,issue_id)
    SELECT i.organization_id,$2,i.id FROM cloud_issues i
    WHERE i.organization_id=$1 AND i.team_id=ANY($3::uuid[]) AND i.state='complete' AND NOT i.archived
    AND ($4::date IS NULL OR i.updated_at>=$4::date)
    AND NOT EXISTS (SELECT 1 FROM cloud_release_items x JOIN cloud_releases o ON o.organization_id=x.organization_id AND o.id=x.release_id
      WHERE x.organization_id=i.organization_id AND x.issue_id=i.id AND x.included AND o.id<>$2 AND o.product_id=(SELECT product_id FROM cloud_releases WHERE organization_id=$1 AND id=$2))
    ORDER BY i.updated_at DESC LIMIT ${maximumItems}
    ON CONFLICT DO NOTHING`,
    [organizationId, release.id, product.teamIds, release.since],
  );
}

async function readItems(
  sql: CloudSql,
  actor: CloudActor,
  releaseId: string,
): Promise<ReleaseItem[]> {
  return (
    await sql.query<ReleaseItem & Record<string, unknown>>(
      `SELECT i.id AS "issueId",i.identifier,i.title,i.state,${timestamp("i.updated_at")} AS "completedAt",x.included,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('title',g.title,'url',g.url) ORDER BY g.number) FROM cloud_github_pull_request_issues gl
        JOIN cloud_github_pull_requests g ON g.organization_id=gl.organization_id AND g.id=gl.pull_request_id
        WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id AND g.state='merged'),'[]'::jsonb) AS "pullRequests"
      FROM cloud_release_items x JOIN cloud_issues i ON i.organization_id=x.organization_id AND i.id=x.issue_id
      JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
      JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
      WHERE x.organization_id=$1 AND x.release_id=$3 AND ${teamVisibility}
      ORDER BY x.included DESC,i.updated_at DESC`,
      [actor.organizationId, actor.userId, releaseId],
    )
  ).rows;
}

async function readJobs(
  sql: CloudSql,
  organizationId: string,
  releaseId: string,
): Promise<ReleaseJob[]> {
  return (
    await sql.query<ReleaseJob & Record<string, unknown>>(
      `SELECT id,kind,state,detail,error,chat_id AS "chatId",${timestamp("created_at")} AS "createdAt",${timestamp("finished_at")} AS "finishedAt"
      FROM cloud_release_jobs WHERE organization_id=$1 AND release_id=$2 ORDER BY created_at DESC LIMIT 20`,
      [organizationId, releaseId],
    )
  ).rows;
}

export function canPublish(role: CloudRole, product: ProductInput): boolean {
  return (
    role === "owner" ||
    role === "admin" ||
    (role === "member" && product.membersCanPublish)
  );
}

function summary(
  row: ReleaseRow,
  posts: Pick<
    ReleasePost,
    "state" | "scheduledAt" | "publishedAt" | "channelKind"
  >[],
  counts: { media: number; items: number },
): CloudReleaseSummary {
  const product = row.productDefinition;
  const scheduled = posts
    .filter((post) => post.state === "scheduled" && post.scheduledAt)
    .map((post) => post.scheduledAt!)
    .sort();
  const published = posts
    .map((post) => post.publishedAt)
    .filter((value): value is string => value !== null)
    .sort();
  const status = releaseStatus(posts);
  return {
    id: row.id,
    productId: row.productId,
    productName: product.name,
    productKey: product.key,
    brand: product.brand,
    version: row.version,
    name: row.name,
    status,
    targetDate: row.targetDate,
    nextScheduledAt: scheduled[0] ?? null,
    publishedAt: status === "published" ? (published.at(-1) ?? null) : null,
    channels: posts.map((post) => ({
      kind: post.channelKind,
      state: post.state,
    })),
    mediaCount: counts.media,
    itemCount: counts.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function counts(
  sql: CloudSql,
  organizationId: string,
  releaseId: string,
) {
  return (
    await sql.query<{ media: number; items: number }>(
      `SELECT (SELECT count(*)::integer FROM cloud_release_media WHERE organization_id=$1 AND release_id=$2 AND state='ready') AS media,
      (SELECT count(*)::integer FROM cloud_release_items WHERE organization_id=$1 AND release_id=$2 AND included) AS items`,
      [organizationId, releaseId],
    )
  ).rows[0]!;
}

export async function touchRelease(
  sql: CloudSql,
  organizationId: string,
  releaseId: string,
): Promise<void> {
  await sql.query(
    "UPDATE cloud_releases SET updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    [organizationId, releaseId],
  );
}

export class CloudReleases {
  constructor(
    private readonly database: CloudDatabase,
    private readonly wakePublisher: () => void,
  ) {}

  list(
    actor: CloudActor,
    filters: { productId?: string; archived?: boolean } = {},
  ): Promise<CloudReleaseSummary[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<ReleaseRow & Record<string, unknown>>(
          `SELECT ${releaseColumns} FROM ${releaseFrom} WHERE r.organization_id=$1 AND r.archived=$2 AND ($3::uuid IS NULL OR r.product_id=$3)
          ORDER BY r.updated_at DESC,r.id LIMIT 200`,
          [
            actor.organizationId,
            filters.archived ?? false,
            filters.productId ?? null,
          ],
        )
      ).rows;
      const result: CloudReleaseSummary[] = [];
      for (const row of rows)
        result.push(
          summary(
            row,
            await readPosts(sql, actor.organizationId, row.id),
            await counts(sql, actor.organizationId, row.id),
          ),
        );
      return result;
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudRelease> {
    return this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor);
      const row = await readReleaseRow(sql, actor.organizationId, id);
      if (!row.archived) await ensurePosts(sql, actor.organizationId, row);
      const posts = await readPosts(sql, actor.organizationId, id);
      return {
        ...summary(row, posts, await counts(sql, actor.organizationId, id)),
        revision: row.revision,
        archived: row.archived,
        summary: row.summary,
        notes: row.notes,
        highlights: row.highlights,
        since: row.since,
        posts,
        items: await readItems(sql, actor, id),
        jobs: await readJobs(sql, actor.organizationId, id),
        canPublish: canPublish(role, row.productDefinition),
      };
    });
  }

  find(actor: CloudActor, reference: string): Promise<{ id: string } | null> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const value = reference.trim();
      const match = (
        await sql.query<{ id: string }>(
          `SELECT r.id FROM ${releaseFrom} WHERE r.organization_id=$1 AND NOT r.archived
          AND (r.id::text=$2 OR lower(r.version)=lower($2) OR lower((pr.definition->>'name')||' '||r.version)=lower($2) OR lower(pr.key||' '||r.version)=lower($2))
          ORDER BY r.updated_at DESC LIMIT 1`,
          [actor.organizationId, value],
        )
      ).rows[0];
      return match ?? null;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: ReleaseInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const product = await readProduct(
        sql,
        actor.organizationId,
        input.productId,
      );
      if (product.archived)
        throw new CloudError(
          409,
          "product_archived",
          "Restore the product first.",
        );
      return command(
        sql,
        actor,
        key,
        { kind: "release.create", input },
        async () => {
          const duplicate = await sql.query(
            "SELECT 1 FROM cloud_releases WHERE organization_id=$1 AND product_id=$2 AND lower(version)=lower($3)",
            [actor.organizationId, input.productId, input.version],
          );
          if (duplicate.rows.length)
            throw new CloudError(
              409,
              "release_version",
              `${product.name} ${input.version} already exists.`,
            );
          const since =
            input.since ??
            (
              await sql.query<{ since: string | null }>(
                "SELECT to_char(max(created_at),'YYYY-MM-DD') AS since FROM cloud_releases WHERE organization_id=$1 AND product_id=$2",
                [actor.organizationId, input.productId],
              )
            ).rows[0]!.since;
          const id = randomUUID();
          await sql.query(
            `INSERT INTO cloud_releases (organization_id,id,product_id,version,name,since,target_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              actor.organizationId,
              id,
              input.productId,
              input.version,
              input.name,
              since,
              input.targetDate,
              actor.userId,
            ],
          );
          await collectItems(sql, actor.organizationId, { id, since }, product);
          await ensurePosts(sql, actor.organizationId, {
            id,
            productId: input.productId,
          });
          await recordEvent(sql, actor, "release.created", id, 1, {});
          await queueReleaseAutomations(sql, {
            organizationId: actor.organizationId,
            actorId: actor.userId,
            release: { id, productId: input.productId },
          });
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ReleaseUpdate,
  ): Promise<{ id: string; revision: number }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const current = await readReleaseRow(sql, actor.organizationId, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "release.update", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          if (current.archived)
            throw new CloudError(
              409,
              "release_archived",
              "Restore the release first.",
            );
          if (input.version.toLowerCase() !== current.version.toLowerCase()) {
            const duplicate = await sql.query(
              "SELECT 1 FROM cloud_releases WHERE organization_id=$1 AND product_id=$2 AND lower(version)=lower($3) AND id<>$4",
              [actor.organizationId, current.productId, input.version, id],
            );
            if (duplicate.rows.length)
              throw new CloudError(
                409,
                "release_version",
                "Another release uses this version.",
              );
          }
          await sql.query(
            `UPDATE cloud_releases SET version=$3,name=$4,summary=$5,notes=$6,highlights=$7,target_date=$8,revision=revision+1,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              input.version,
              input.name,
              input.summary,
              input.notes,
              JSON.stringify(input.highlights),
              input.targetDate,
            ],
          );
          return { id, revision: current.revision + 1 };
        },
      );
    });
  }

  setItems(
    actor: CloudActor,
    id: string,
    input: { revision: number; excludedIssueIds: string[] },
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const current = await readReleaseRow(sql, actor.organizationId, id, true);
      checkRevision(current.revision, input.revision);
      await sql.query(
        "UPDATE cloud_release_items SET included=NOT (issue_id=ANY($3::uuid[])) WHERE organization_id=$1 AND release_id=$2",
        [actor.organizationId, id, input.excludedIssueIds],
      );
      await touchRelease(sql, actor.organizationId, id);
    });
  }

  refreshItems(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const current = await readReleaseRow(sql, actor.organizationId, id, true);
      await collectItems(
        sql,
        actor.organizationId,
        current,
        current.productDefinition,
      );
      await touchRelease(sql, actor.organizationId, id);
    });
  }

  archive(
    actor: CloudActor,
    id: string,
    input: { revision: number; archived: boolean },
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const current = await readReleaseRow(sql, actor.organizationId, id, true);
      checkRevision(current.revision, input.revision);
      if (input.archived) {
        const active = await sql.query(
          "SELECT 1 FROM cloud_release_posts WHERE organization_id=$1 AND release_id=$2 AND state IN ('scheduled','publishing') LIMIT 1",
          [actor.organizationId, id],
        );
        if (active.rows.length)
          throw new CloudError(
            409,
            "release_scheduled",
            "Unschedule its posts before archiving the release.",
          );
      }
      await sql.query(
        "UPDATE cloud_releases SET archived=$3,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, input.archived],
      );
    });
  }

  private async readPost(sql: CloudSql, organizationId: string, id: string) {
    const post = (
      await sql.query<ReleasePost & Record<string, unknown>>(
        `SELECT ${postColumns} FROM ${postFrom} WHERE p.organization_id=$1 AND p.id=$2 FOR UPDATE OF p`,
        [organizationId, id],
      )
    ).rows[0];
    if (!post) throw new CloudError(404, "not_found", "Post is unavailable.");
    return post;
  }

  private async requireMedia(
    sql: CloudSql,
    organizationId: string,
    releaseId: string,
    mediaIds: string[],
  ): Promise<void> {
    if (!mediaIds.length) return;
    const found = await sql.query(
      `SELECT m.id FROM cloud_release_media m JOIN cloud_releases r ON r.organization_id=m.organization_id AND r.id=$2
      WHERE m.organization_id=$1 AND m.id=ANY($3::uuid[]) AND m.state='ready' AND m.product_id=r.product_id AND (m.release_id IS NULL OR m.release_id=$2)`,
      [organizationId, releaseId, mediaIds],
    );
    if (found.rows.length !== new Set(mediaIds).size)
      throw new CloudError(
        422,
        "media_unavailable",
        "A selected file is unavailable.",
      );
  }

  updatePost(
    actor: CloudActor,
    key: string,
    id: string,
    input: {
      revision: number;
      title: string;
      body: string;
      mediaIds: string[];
      link: string | null;
    },
  ): Promise<ReleasePost> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const post = await this.readPost(sql, actor.organizationId, id);
      await command(
        sql,
        actor,
        key,
        { kind: "release.post.update", id, input },
        async () => {
          checkRevision(post.revision, input.revision);
          if (["publishing", "published"].includes(post.state))
            throw new CloudError(
              409,
              "post_published",
              "Published posts can't be edited.",
            );
          await this.requireMedia(
            sql,
            actor.organizationId,
            post.releaseId,
            input.mediaIds,
          );
          await sql.query(
            `UPDATE cloud_release_posts SET title=$3,body=$4,media_ids=$5,link=$6,
          state=CASE WHEN state='failed' THEN 'failed' ELSE 'draft' END,scheduled_at=NULL,approved_by=NULL,approved_at=NULL,revision=revision+1
          WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              input.title,
              input.body,
              input.mediaIds,
              input.link,
            ],
          );
          await touchRelease(sql, actor.organizationId, post.releaseId);
          return { id };
        },
      );
      return this.readPost(sql, actor.organizationId, id);
    });
  }

  async changePost(
    actor: CloudActor,
    key: string,
    id: string,
    change: PostStateChange,
  ): Promise<ReleasePost> {
    const post = await this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor, "write");
      const current = await this.readPost(sql, actor.organizationId, id);
      const release = await readReleaseRow(
        sql,
        actor.organizationId,
        current.releaseId,
      );
      const channel = (
        await sql.query<{ requiresApproval: boolean; enabled: boolean }>(
          `SELECT (definition->>'requiresApproval')::boolean AS "requiresApproval",(definition->>'enabled')::boolean AS enabled FROM cloud_product_channels WHERE organization_id=$1 AND id=$2`,
          [actor.organizationId, current.channelId],
        )
      ).rows[0]!;
      await command(
        sql,
        actor,
        key,
        { kind: "release.post.state", id, change },
        async () => {
          checkRevision(current.revision, change.revision);
          if (release.archived)
            throw new CloudError(
              409,
              "release_archived",
              "Restore the release first.",
            );
          const publishing =
            change.action === "schedule" ||
            change.action === "publish" ||
            change.action === "retry" ||
            change.action === "manual";
          if (publishing && !canPublish(role, release.productDefinition))
            throw new CloudError(
              403,
              "publish_denied",
              "Only administrators can publish this product's posts.",
            );
          if (publishing && !channel.enabled)
            throw new CloudError(
              409,
              "channel_disabled",
              "Enable the channel before publishing.",
            );
          if (
            publishing &&
            change.action !== "retry" &&
            change.action !== "manual" &&
            !current.body.trim() &&
            !current.mediaIds.length
          )
            throw new CloudError(
              422,
              "post_empty",
              "Write the post before publishing it.",
            );
          if (
            (change.action === "schedule" || change.action === "publish") &&
            channel.requiresApproval &&
            current.state !== "approved" &&
            current.state !== "scheduled"
          )
            throw new CloudError(
              409,
              "approval_required",
              "Approve the post before publishing it.",
            );
          if (change.action === "approve") {
            if (current.state !== "draft")
              throw new CloudError(
                409,
                "post_state",
                "Only drafts can be approved.",
              );
            if (!current.body.trim() && !current.mediaIds.length)
              throw new CloudError(
                422,
                "post_empty",
                "Write the post before approving it.",
              );
            await sql.query(
              "UPDATE cloud_release_posts SET state='approved',approved_by=$3,approved_at=clock_timestamp(),error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id, actor.userId],
            );
          } else if (change.action === "reopen") {
            if (!["approved", "scheduled", "failed"].includes(current.state))
              throw new CloudError(
                409,
                "post_state",
                "This post can't return to draft.",
              );
            if (
              current.deliveries.some(
                (delivery) => delivery.state === "published",
              )
            )
              throw new CloudError(
                409,
                "post_partially_published",
                "Part of this post is already live. Retry it instead.",
              );
            await sql.query(
              "UPDATE cloud_release_posts SET state='draft',scheduled_at=NULL,approved_by=NULL,approved_at=NULL,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id],
            );
          } else if (change.action === "manual") {
            if (["publishing", "published"].includes(current.state))
              throw new CloudError(
                409,
                "post_state",
                "This post is already published.",
              );
            await sql.query(
              `INSERT INTO cloud_release_deliveries (organization_id,post_id,target,state,url,attempts,completed_at)
              VALUES ($1,$2,'manual','published',$3,1,clock_timestamp())
              ON CONFLICT (organization_id,post_id,target) DO UPDATE SET state='published',url=$3,error=NULL,completed_at=clock_timestamp()`,
              [actor.organizationId, id, change.url],
            );
            await sql.query(
              `UPDATE cloud_release_posts SET state='published',published_at=clock_timestamp(),scheduled_at=NULL,publisher_id=$3,
              approved_by=COALESCE(approved_by,$3),approved_at=COALESCE(approved_at,clock_timestamp()),error=NULL,revision=revision+1
              WHERE organization_id=$1 AND id=$2`,
              [actor.organizationId, id, actor.userId],
            );
          } else if (change.action === "retry") {
            if (current.state !== "failed")
              throw new CloudError(
                409,
                "post_state",
                "Only failed posts can be retried.",
              );
            await sql.query(
              "UPDATE cloud_release_posts SET state='scheduled',scheduled_at=clock_timestamp(),publisher_id=$3,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id, actor.userId],
            );
          } else {
            if (["publishing", "published", "failed"].includes(current.state))
              throw new CloudError(
                409,
                "post_state",
                "This post can't be scheduled now.",
              );
            const at = change.action === "publish" ? null : change.at;
            if (at !== null) {
              const valid = (
                await sql.query<{ valid: boolean }>(
                  "SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<clock_timestamp()+interval '1 year' AS valid",
                  [at],
                )
              ).rows[0]!.valid;
              if (!valid)
                throw new CloudError(
                  422,
                  "schedule_time",
                  "Choose a time within the next year.",
                );
            }
            await sql.query(
              `UPDATE cloud_release_posts SET state='scheduled',scheduled_at=COALESCE($3::timestamptz,clock_timestamp()),publisher_id=$4,
            approved_by=COALESCE(approved_by,$4),approved_at=COALESCE(approved_at,clock_timestamp()),error=NULL,revision=revision+1
            WHERE organization_id=$1 AND id=$2`,
              [actor.organizationId, id, at, actor.userId],
            );
          }
          await touchRelease(sql, actor.organizationId, current.releaseId);
          return { id };
        },
      );
      return this.readPost(sql, actor.organizationId, id);
    });
    if (post.state === "scheduled") this.wakePublisher();
    return post;
  }

  async launch(
    actor: CloudActor,
    key: string,
    id: string,
    input: ReleaseLaunch,
  ): Promise<ReleaseLaunchResult> {
    const release = await this.get(actor, id);
    if (!release.canPublish)
      throw new CloudError(
        403,
        "publish_denied",
        "Only administrators can publish this product's posts.",
      );
    const result: ReleaseLaunchResult = { launched: 0, skipped: [] };
    for (const post of release.posts) {
      if (["scheduled", "publishing", "published"].includes(post.state))
        continue;
      if (post.state === "failed") {
        result.skipped.push({
          channelName: post.channelName,
          reason: "Failed earlier. Retry it from its card.",
        });
        continue;
      }
      try {
        await this.changePost(
          actor,
          derivedCommandId(`${key}:${post.id}`, "release-launch"),
          post.id,
          input.action === "publish"
            ? { action: "publish", revision: post.revision }
            : { action: "schedule", revision: post.revision, at: input.at },
        );
        result.launched++;
      } catch (error) {
        if (!isCloudError(error) || error.status >= 500) throw error;
        result.skipped.push({
          channelName: post.channelName,
          reason: error.message,
        });
      }
    }
    return result;
  }
}
