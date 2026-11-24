import { z } from "zod";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitPullRequestFile,
  GitReviewGuide,
  GitReviewGuideInput,
  GitReviewGuideSection,
  GitReviewGuideState,
} from "../../../lib/cloud-git-contract";
import { CloudError, isCloudError } from "../access";
import type { CloudChatStore } from "../ai/chat-store";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase, CloudSql } from "../database";
import type { CloudGitPullRequests } from "./pull-requests";
import { readVisiblePullRequest } from "./pull-requests";
import { gitReviewSettings } from "./review-settings";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const maximumPatchCharacters = 60_000;
const maximumFilePatchCharacters = 8_000;

const guideAnswerSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        purpose: z.string().trim().max(2000),
        impact: z.string().trim().max(2000),
        files: z.array(z.string()).max(1000),
      }),
    )
    .min(1)
    .max(30),
});

interface WaitingGuide {
  organizationId: string;
  id: string;
  actorId: string;
  pullRequestId: string;
  turnId: string;
}

export function reviewGuidePrompt(
  pullRequest: { repository: string; number: number; title: string },
  files: GitPullRequestFile[],
): string {
  let budget = maximumPatchCharacters;
  const diffs = files.map((file) => {
    const header = `### ${file.filename} (${file.status}, +${file.additions} −${file.deletions})`;
    const patch = (file.patch ?? "").slice(
      0,
      Math.max(0, Math.min(maximumFilePatchCharacters, budget)),
    );
    budget -= patch.length;
    return patch ? `${header}\n\`\`\`diff\n${patch}\n\`\`\`` : header;
  });
  return [
    `Write a review guide for pull request #${pullRequest.number} "${pullRequest.title}" in ${pullRequest.repository}.`,
    "",
    "Group related changes into sections in the order a reviewer should read them. Give each section a short title, its purpose (what changes and why) and its impact (what it affects and what to check). Put every changed file in exactly one section.",
    "",
    "Reply with only this JSON:",
    '{"sections":[{"title":"","purpose":"","impact":"","files":["path"]}]}',
    "",
    "Nobody can answer questions, so do not call ask_user.",
    "",
    "Changed files:",
    ...diffs,
  ].join("\n");
}

export function parseReviewGuide(
  answer: string,
  files: string[],
): GitReviewGuideSection[] | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(answer.slice(start, end + 1));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = guideAnswerSchema.safeParse(value);
  if (!parsed.success) return null;
  const known = new Set(files);
  const claimed = new Set<string>();
  return parsed.data.sections.map((section) => ({
    title: section.title,
    purpose: section.purpose,
    impact: section.impact,
    files: section.files.filter((file) => {
      if (!known.has(file) || claimed.has(file)) return false;
      claimed.add(file);
      return true;
    }),
  }));
}

async function readGuide(
  sql: CloudSql,
  organizationId: string,
  pullRequestId: string,
  headSha: string,
): Promise<GitReviewGuide | null> {
  const guide = (
    await sql.query<Omit<GitReviewGuide, "sections"> & Record<string, unknown>>(
      `SELECT id,head_sha AS "headSha",state,error,to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS "createdAt"
      FROM cloud_git_review_guides WHERE organization_id=$1 AND pull_request_id=$2 AND head_sha=$3`,
      [organizationId, pullRequestId, headSha],
    )
  ).rows[0];
  if (!guide) return null;
  const sections = (
    await sql.query<GitReviewGuideSection & Record<string, unknown>>(
      `SELECT s.title,s.purpose,s.impact,COALESCE((SELECT array_agg(f.path ORDER BY f.path) FROM cloud_git_review_guide_files f
        WHERE f.organization_id=s.organization_id AND f.guide_id=s.guide_id AND f.section_position=s.position),'{}') AS files
      FROM cloud_git_review_guide_sections s WHERE s.organization_id=$1 AND s.guide_id=$2 ORDER BY s.position`,
      [organizationId, guide.id],
    )
  ).rows;
  return { ...guide, sections };
}

export class CloudGitReviewGuides {
  constructor(
    private readonly database: CloudDatabase,
    private readonly pullRequests: CloudGitPullRequests,
    private readonly chat: CloudChatStore,
    private readonly wake: () => void,
  ) {}

  get(actor: CloudActor, pullRequestId: string): Promise<GitReviewGuideState> {
    return this.database.transaction(async (sql) => {
      const pullRequest = await readVisiblePullRequest(
        sql,
        actor,
        pullRequestId,
      );
      return {
        enabled: (await gitReviewSettings(sql, actor.organizationId))
          .reviewGuides,
        guide: await readGuide(
          sql,
          actor.organizationId,
          pullRequestId,
          pullRequest.headSha,
        ),
      };
    });
  }

  async start(
    actor: CloudActor,
    key: string,
    pullRequestId: string,
    input: GitReviewGuideInput,
  ): Promise<GitReviewGuide> {
    const { pullRequest, existing } = await this.database.transaction(
      async (sql) => {
        const pullRequest = await readVisiblePullRequest(
          sql,
          actor,
          pullRequestId,
        );
        if (!(await gitReviewSettings(sql, actor.organizationId)).reviewGuides)
          throw new CloudError(
            409,
            "review_guides_off",
            "Review guides are off.",
          );
        const existing = await readGuide(
          sql,
          actor.organizationId,
          pullRequestId,
          pullRequest.headSha,
        );
        if (existing?.state !== "failed") return { pullRequest, existing };
        await sql.query(
          "DELETE FROM cloud_git_review_guides WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, existing.id],
        );
        return { pullRequest, existing: null };
      },
    );
    if (existing) return existing;
    const files = await this.pullRequests.files(actor, pullRequestId);
    const id = derivedCommandId(key, "review-guide");
    const inserted = await this.database.transaction((sql) =>
      sql.query(
        `INSERT INTO cloud_git_review_guides (organization_id,id,pull_request_id,head_sha,actor_id,state)
        VALUES ($1,$2,$3,$4,$5,'waiting') ON CONFLICT DO NOTHING RETURNING id`,
        [
          actor.organizationId,
          id,
          pullRequestId,
          pullRequest.headSha,
          actor.userId,
        ],
      ),
    );
    if (inserted.rows.length) {
      try {
        const submission = await this.chat.startHiddenChat(actor, key, {
          owner: { reviewGuideId: id },
          providerId: input.providerId,
          model: input.model,
          prompt: reviewGuidePrompt(pullRequest, files),
          context: [],
        });
        await this.database.transaction((sql) =>
          sql.query(
            "UPDATE cloud_git_review_guides SET chat_id=$3,turn_id=$4 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, submission.chatId, submission.turnId],
          ),
        );
      } catch (error) {
        await this.database.transaction((sql) =>
          sql.query(
            "DELETE FROM cloud_git_review_guides WHERE organization_id=$1 AND id=$2 AND turn_id IS NULL",
            [actor.organizationId, id],
          ),
        );
        throw error;
      }
      this.wake();
    }
    return (await this.database.transaction((sql) =>
      readGuide(sql, actor.organizationId, pullRequestId, pullRequest.headSha),
    ))!;
  }

  async tick(): Promise<number> {
    const guides = (
      await this.database.transaction(async (sql) => {
        await sql.query(
          `UPDATE cloud_git_review_guides SET state='failed',error='Agent did not start.',finished_at=clock_timestamp()
          WHERE state='waiting' AND turn_id IS NULL AND created_at<clock_timestamp()-interval '5 minutes'`,
        );
        return sql.query<WaitingGuide & Record<string, unknown>>(
          `SELECT organization_id AS "organizationId",id,actor_id AS "actorId",pull_request_id AS "pullRequestId",turn_id AS "turnId"
          FROM cloud_git_review_guides WHERE state='waiting' AND turn_id IS NOT NULL ORDER BY created_at,id LIMIT 5`,
        );
      })
    ).rows;
    let work = 0;
    for (const guide of guides) {
      try {
        if (await this.settle(guide)) work++;
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.fail(guide, error.message);
        work++;
      }
    }
    return work;
  }

  private fail(guide: WaitingGuide, error: string): Promise<unknown> {
    return this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_git_review_guides SET state='failed',error=$3,finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [guide.organizationId, guide.id, error.slice(0, 500)],
      ),
    );
  }

  private async settle(guide: WaitingGuide): Promise<boolean> {
    const turn = (
      await this.database.transaction((sql) =>
        sql.query<{ state: string; error_code: string | null; answer: string }>(
          "SELECT state,error_code,answer FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
          [guide.organizationId, guide.turnId],
        ),
      )
    ).rows[0];
    if (!turn) {
      await this.fail(guide, "The Agent conversation is unavailable.");
      return true;
    }
    if (["queued", "running", "cancel_requested"].includes(turn.state))
      return false;
    if (turn.state !== "complete") {
      await this.fail(
        guide,
        `Agent did not finish${turn.error_code ? ` (${turn.error_code.replaceAll("_", " ")})` : ""}.`,
      );
      return true;
    }
    const files = await this.pullRequests.files(
      { organizationId: guide.organizationId, userId: guide.actorId },
      guide.pullRequestId,
    );
    const sections = parseReviewGuide(
      turn.answer,
      files.map((file) => file.filename),
    );
    if (!sections) {
      await this.fail(guide, "Agent did not return a guide.");
      return true;
    }
    await this.database.transaction(async (sql) => {
      for (const [position, section] of sections.entries()) {
        await sql.query(
          "INSERT INTO cloud_git_review_guide_sections (organization_id,guide_id,position,title,purpose,impact) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            guide.organizationId,
            guide.id,
            position,
            section.title,
            section.purpose,
            section.impact,
          ],
        );
        for (const path of section.files)
          await sql.query(
            "INSERT INTO cloud_git_review_guide_files (organization_id,guide_id,section_position,path) VALUES ($1,$2,$3,$4)",
            [guide.organizationId, guide.id, position, path],
          );
      }
      await sql.query(
        "UPDATE cloud_git_review_guides SET state='ready',finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [guide.organizationId, guide.id],
      );
    });
    return true;
  }
}
