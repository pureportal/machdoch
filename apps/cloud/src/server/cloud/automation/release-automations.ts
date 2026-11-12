import type { ChangeMeasure } from "../../../lib/cloud-automation-contract";
import type { CloudSql } from "../database";
import { automationScope, maximumAutomationDepth } from "./automation-events";
import {
  insertAutomationRun,
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";

const postedStates = "('scheduled','publishing','published')";

export async function queueReleaseAutomations(
  sql: CloudSql,
  input: {
    organizationId: string;
    actorId: string;
    release: { id: string; productId: string };
  },
): Promise<void> {
  const scope = automationScope.getStore();
  const depth = scope?.depth ?? 0;
  if (depth >= maximumAutomationDepth) return;
  const automations = (
    await sql.query<StoredAutomation & Record<string, unknown>>(
      `SELECT ${storedAutomationColumns} FROM cloud_automations WHERE organization_id=$1 AND enabled AND trigger_kind='release_created'
      AND (jsonb_array_length(trigger->'productIds')=0 OR trigger->'productIds' @> jsonb_build_array($2::text)) ORDER BY created_at,id`,
      [input.organizationId, input.release.productId],
    )
  ).rows;
  for (const automation of automations) {
    if (automation.id === scope?.automationId) continue;
    await insertAutomationRun(sql, input.organizationId, automation, {
      dedupeKey: `release:${input.release.id}`,
      trigger: "release_created",
      issueId: null,
      actorId: input.actorId,
      depth,
      variables: { release: { id: input.release.id } },
    });
  }
}

export interface UnannouncedRelease {
  version: string;
  items: { identifier: string; title: string }[];
}

export interface ChannelChanges {
  channelId: string;
  value: number;
  lastPostedVersion: string | null;
  earlier: UnannouncedRelease[];
}

export async function changesSinceLastPost(
  sql: CloudSql,
  organizationId: string,
  releaseId: string,
  channelIds: string[],
  measure: ChangeMeasure,
): Promise<ChannelChanges[]> {
  const current = (
    await sql.query<{ productId: string; createdAt: string }>(
      `SELECT product_id AS "productId",created_at::text AS "createdAt" FROM cloud_releases WHERE organization_id=$1 AND id=$2`,
      [organizationId, releaseId],
    )
  ).rows[0]!;
  const result: ChannelChanges[] = [];
  for (const channelId of channelIds) {
    const last = (
      await sql.query<{ version: string; createdAt: string }>(
        `SELECT r.version,r.created_at::text AS "createdAt" FROM cloud_releases r JOIN cloud_release_posts p ON p.organization_id=r.organization_id AND p.release_id=r.id
        WHERE r.organization_id=$1 AND r.product_id=$2 AND r.id<>$3 AND r.created_at<=$4::timestamptz AND p.channel_id=$5 AND p.state IN ${postedStates}
        ORDER BY r.created_at DESC LIMIT 1`,
        [
          organizationId,
          current.productId,
          releaseId,
          current.createdAt,
          channelId,
        ],
      )
    ).rows[0];
    const releases = (
      await sql.query<{ id: string; version: string }>(
        `SELECT r.id,r.version FROM cloud_releases r WHERE r.organization_id=$1 AND r.product_id=$2 AND (r.id=$3 OR NOT r.archived)
        AND r.created_at<=$4::timestamptz AND ($5::timestamptz IS NULL OR r.created_at>$5::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM cloud_release_posts p WHERE p.organization_id=r.organization_id AND p.release_id=r.id AND p.channel_id=$6 AND p.state IN ${postedStates})
        ORDER BY r.created_at,r.id`,
        [
          organizationId,
          current.productId,
          releaseId,
          current.createdAt,
          last?.createdAt ?? null,
          channelId,
        ],
      )
    ).rows;
    const items = (
      await sql.query<{
        releaseId: string;
        identifier: string;
        title: string;
        points: number | null;
      }>(
        `SELECT DISTINCT ON (i.id) x.release_id AS "releaseId",i.identifier,i.title,i.estimate_points AS points
        FROM cloud_release_items x JOIN cloud_issues i ON i.organization_id=x.organization_id AND i.id=x.issue_id
        WHERE x.organization_id=$1 AND x.release_id=ANY($2::uuid[]) AND x.included ORDER BY i.id`,
        [organizationId, releases.map((release) => release.id)],
      )
    ).rows;
    result.push({
      channelId,
      value:
        measure === "points"
          ? items.reduce((total, item) => total + (item.points ?? 0), 0)
          : items.length,
      lastPostedVersion: last?.version ?? null,
      earlier: releases
        .filter((release) => release.id !== releaseId)
        .map((release) => ({
          version: release.version,
          items: items
            .filter((item) => item.releaseId === release.id)
            .map(({ identifier, title }) => ({ identifier, title })),
        })),
    });
  }
  return result;
}
