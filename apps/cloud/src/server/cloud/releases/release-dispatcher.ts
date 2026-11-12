import type { AgentAction } from "../../../lib/cloud-chat-contract";
import type { VideoInput } from "../../../lib/cloud-release-media-contract";
import { isCloudError } from "../access";
import type { CloudAgentActions } from "../ai/agent-actions";
import type { CloudDatabase } from "../database";
import type { CloudReleaseMedia } from "./release-media";
import type { CloudReleasePublisher } from "./release-publisher";
import type { CloudReleaseStudio } from "./release-studio";
import { touchRelease } from "./releases";

interface Job {
  organizationId: string;
  id: string;
  releaseId: string;
  kind: "write" | "video" | "capture";
  state: string;
  actorId: string;
  input: unknown;
  turnId: string | null;
}

const applyOrder: AgentAction["kind"][] = [
  "release_notes",
  "release_post",
  "release_visual",
];

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export class CloudReleaseDispatcher {
  constructor(
    private readonly database: CloudDatabase,
    private readonly publisher: CloudReleasePublisher,
    private readonly studio: CloudReleaseStudio,
    private readonly media: CloudReleaseMedia,
    private readonly agentActions: CloudAgentActions,
  ) {}

  async tick(): Promise<number> {
    let work = 0;
    for (const post of await this.publisher.due(5)) {
      await this.publisher.publish(post.organizationId, post.id);
      work++;
    }
    const jobs = (
      await this.database.transaction(async (sql) => {
        await sql.query(
          "DELETE FROM cloud_release_media WHERE state='uploading' AND created_at<clock_timestamp()-interval '1 hour'",
        );
        await sql.query(
          `UPDATE cloud_release_jobs j SET state='failed',error='No captures arrived before the upload link expired.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE j.kind='capture' AND j.state='waiting' AND NOT EXISTS (SELECT 1 FROM cloud_release_capture_tokens t WHERE t.organization_id=j.organization_id AND t.job_id=j.id AND t.expires_at>clock_timestamp())`,
        );
        return sql.query<Job & Record<string, unknown>>(
          `SELECT organization_id AS "organizationId",id,release_id AS "releaseId",kind,state,actor_id AS "actorId",input,turn_id AS "turnId"
          FROM cloud_release_jobs WHERE (kind='video' AND state IN ('queued','running')) OR (kind='write' AND state='waiting') ORDER BY updated_at,id LIMIT 5`,
        );
      })
    ).rows;
    for (const job of jobs) {
      try {
        if (job.kind === "video") {
          await this.video(job);
          work++;
        } else if (await this.write(job)) work++;
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.finish(job, "failed", "", error.message);
      }
    }
    return work;
  }

  private async finish(
    job: Job,
    state: "succeeded" | "failed",
    detail: string,
    error: string | null,
  ): Promise<void> {
    await this.database.transaction(async (sql) => {
      await sql.query(
        `UPDATE cloud_release_jobs SET state=$3,detail=$4,error=$5,turn_id=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2`,
        [
          job.organizationId,
          job.id,
          state,
          detail.slice(0, 500),
          error?.slice(0, 500) ?? null,
        ],
      );
      await touchRelease(sql, job.organizationId, job.releaseId);
    });
  }

  private async video(job: Job): Promise<void> {
    const input = job.input as VideoInput;
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_release_jobs SET state='running',detail='Rendering',updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [job.organizationId, job.id],
      ),
    );
    const context = await this.studio.visualContext(
      job.organizationId,
      job.releaseId,
      null,
    );
    const files = new Map<
      string,
      { bytes: Buffer; mime: string; kind: "image" | "video" }
    >();
    for (const clip of input.clips) {
      if (files.has(clip.mediaId)) continue;
      const file = await this.media.bytes(job.organizationId, clip.mediaId);
      files.set(clip.mediaId, {
        bytes: file.bytes,
        mime: file.media.mime,
        kind: file.media.kind,
      });
    }
    const result = await this.studio.composer.compose(input, context, files);
    await this.media.store(
      job.organizationId,
      job.actorId,
      { productId: context.productId, releaseId: job.releaseId },
      {
        name: `${input.name}.mp4`,
        mime: "video/mp4",
        role: "video",
        source: "composition",
        caption: input.name,
        recipe: input,
        durationMs: result.durationMs,
      },
      result.bytes,
    );
    await this.finish(
      job,
      "succeeded",
      `Rendered ${input.name} · ${Math.round(result.durationMs / 1000)} s`,
      null,
    );
  }

  private async write(job: Job): Promise<boolean> {
    const turn = (
      await this.database.transaction((sql) =>
        sql.query<{
          state: string;
          error_code: string | null;
          actions: AgentAction[];
        }>(
          "SELECT state,error_code,actions FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
          [job.organizationId, job.turnId],
        ),
      )
    ).rows[0];
    if (!turn) {
      await this.finish(
        job,
        "failed",
        "",
        "The Agent conversation is unavailable.",
      );
      return true;
    }
    if (["queued", "running", "cancel_requested"].includes(turn.state))
      return false;
    if (turn.state !== "complete") {
      await this.finish(
        job,
        "failed",
        "",
        `Agent did not finish${turn.error_code ? ` (${turn.error_code.replaceAll("_", " ")})` : ""}.`,
      );
      return true;
    }
    const actor = { organizationId: job.organizationId, userId: job.actorId };
    const pending = turn.actions
      .filter(
        (action) =>
          action.state === "pending" && applyOrder.includes(action.kind),
      )
      .sort(
        (left, right) =>
          applyOrder.indexOf(left.kind) - applyOrder.indexOf(right.kind),
      );
    const applied: AgentAction[] = [];
    const failed: AgentAction[] = [];
    for (const action of pending) {
      const result = await this.agentActions.apply(
        actor,
        job.turnId!,
        action.id,
      );
      (result.state === "applied" ? applied : failed).push(result);
    }
    const count = (kind: AgentAction["kind"]) =>
      applied.filter((action) => action.kind === kind).length;
    const parts = [
      count("release_notes") ? "notes" : "",
      count("release_post") ? plural(count("release_post"), "post") : "",
      count("release_visual") ? plural(count("release_visual"), "visual") : "",
    ].filter(Boolean);
    const detail = parts.length
      ? `Wrote ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}`
      : "";
    const errors = failed
      .map((action) => `${action.title}: ${action.error}`)
      .join(" · ");
    await this.finish(
      job,
      applied.length ? "succeeded" : "failed",
      detail,
      applied.length
        ? errors || null
        : errors || "Agent proposed no release content.",
    );
    return true;
  }
}
