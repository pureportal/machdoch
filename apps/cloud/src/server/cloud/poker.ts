import { randomUUID } from "node:crypto";
import { lockExecution } from "./execution/records";
import type {
  CloudActor,
  EstimateCard,
  PokerCommand,
  PokerRound,
} from "../../lib/cloud-contract";
import type { CloudDatabase, CloudSql } from "./database";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
} from "./access";
import { readIssue, recordIssue } from "./planning";

type StoredRound = Omit<PokerRound, "votes" | "stale"> &
  Record<string, unknown>;

async function readRound(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<{
  round: StoredRound;
  issue: Awaited<ReturnType<typeof readIssue>>;
}> {
  const reference = (
    await sql.query<{ issue_id: string }>(
      "SELECT issue_id FROM cloud_poker_rounds WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!reference)
    throw new CloudError(404, "not_found", "Poker round is unavailable.");
  const issue = await readIssue(sql, actor, reference.issue_id, write);
  const round = (
    await sql.query<StoredRound>(
      `SELECT id,issue_id AS "issueId",facilitator_id AS "facilitatorId",issue_revision AS "issueRevision",
    scale,scale_revision AS "scaleRevision",status,generation,revision,decision,rationale FROM cloud_poker_rounds WHERE organization_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  return { round, issue };
}

export class CloudPoker {
  constructor(private readonly database: CloudDatabase) {}

  create(
    actor: CloudActor,
    commandId: string,
    issueId: string,
    issueRevision: number,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const issue = await readIssue(sql, actor, issueId, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "poker.create", issueId, issueRevision },
        async () => {
          checkRevision(issue.revision, issueRevision);
          if (issue.archived)
            throw new CloudError(
              409,
              "issue_archived",
              "Restore the issue before starting poker.",
            );
          const active = await sql.query(
            "SELECT id FROM cloud_poker_rounds WHERE organization_id=$1 AND issue_id=$2 AND status IN ('voting','revealed')",
            [actor.organizationId, issueId],
          );
          if (active.rows.length)
            throw new CloudError(
              409,
              "round_active",
              "This issue already has an active poker round.",
            );
          const team = await requireTeam(sql, actor, issue.teamId);
          const id = randomUUID();
          await sql.query(
            `INSERT INTO cloud_poker_rounds (organization_id,id,issue_id,facilitator_id,issue_revision,scale,scale_revision) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              actor.organizationId,
              id,
              issueId,
              actor.userId,
              issueRevision,
              JSON.stringify(team.estimateScale),
              team.scaleRevision,
            ],
          );
          await recordEvent(sql, actor, "poker.started", id, 1, { issueId });
          return { id };
        },
      );
    });
  }

  list(
    actor: CloudActor,
    issueId: string,
  ): Promise<
    { id: string; status: PokerRound["status"]; generation: number }[]
  > {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      return (
        await sql.query<{
          id: string;
          status: PokerRound["status"];
          generation: number;
        }>(
          "SELECT id,status,generation FROM cloud_poker_rounds WHERE organization_id=$1 AND issue_id=$2 ORDER BY (status IN ('voting','revealed')) DESC,created_at DESC,id",
          [actor.organizationId, issueId],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<PokerRound> {
    return this.database.transaction(async (sql) => {
      const { round, issue } = await readRound(sql, actor, id);
      const votes = (
        await sql.query<{ userId: string; name: string; card: string | null }>(
          `SELECT v.user_id AS "userId",u.name,
        CASE WHEN $4::boolean OR v.user_id=$5::uuid THEN v.card ELSE NULL END AS card
        FROM cloud_poker_votes v JOIN cloud_users u ON u.id=v.user_id
        JOIN cloud_memberships m ON m.organization_id=v.organization_id AND m.user_id=v.user_id
        JOIN cloud_teams t ON t.organization_id=v.organization_id AND t.id=$6
        WHERE v.organization_id=$1 AND v.round_id=$2 AND v.generation=$3 AND m.active AND NOT u.disabled
        AND (t.visibility='organization' OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM cloud_team_memberships tm WHERE tm.organization_id=m.organization_id AND tm.user_id=m.user_id AND tm.team_id=t.id))
        ORDER BY u.name,v.user_id`,
          [
            actor.organizationId,
            id,
            round.generation,
            round.status === "revealed" || round.status === "decided",
            actor.userId,
            issue.teamId,
          ],
        )
      ).rows;
      return {
        ...round,
        votes,
        stale:
          ["voting", "revealed"].includes(round.status) &&
          (issue.revision !== round.issueRevision || issue.archived),
      };
    });
  }

  vote(
    actor: CloudActor,
    commandId: string,
    id: string,
    revision: number,
    card: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const { round, issue } = await readRound(sql, actor, id, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "poker.vote", id, revision, card },
        async () => {
          checkRevision(round.revision, revision);
          if (round.status !== "voting")
            throw new CloudError(
              409,
              "voting_closed",
              "Voting has ended for this round.",
            );
          if (issue.revision !== round.issueRevision || issue.archived)
            throw new CloudError(
              409,
              "round_stale",
              "The issue changed. Ask the facilitator to restart the round.",
            );
          if (!round.scale.some((entry: EstimateCard) => entry.label === card))
            throw new CloudError(
              422,
              "invalid_card",
              "Choose a card from this round's scale.",
            );
          await sql.query(
            `INSERT INTO cloud_poker_votes (organization_id,round_id,generation,user_id,card) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (organization_id,round_id,generation,user_id) DO UPDATE SET card=excluded.card`,
            [actor.organizationId, id, round.generation, actor.userId, card],
          );
          await recordEvent(sql, actor, "poker.vote_cast", id, round.revision, {
            generation: round.generation,
          });
          return { id };
        },
      );
    });
  }

  act(
    actor: CloudActor,
    commandId: string,
    id: string,
    input: PokerCommand,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const { round, issue } = await readRound(sql, actor, id, true);
      if (input.kind === "takeover")
        await requireMembership(sql, actor, "admin");
      else if (round.facilitatorId !== actor.userId)
        throw new CloudError(
          403,
          "facilitator_required",
          "Only the facilitator can change this round.",
        );
      return command(
        sql,
        actor,
        commandId,
        { kind: "poker.command", id, input },
        async () => {
          checkRevision(round.revision, input.revision);
          if (round.status === "decided" || round.status === "closed")
            throw new CloudError(
              409,
              "round_closed",
              "This round has ended. Start a new round.",
            );
          if (input.kind === "takeover") {
            await sql.query(
              "UPDATE cloud_poker_rounds SET facilitator_id=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id, actor.userId],
            );
          } else if (input.kind === "reveal") {
            if (round.status !== "voting")
              throw new CloudError(
                409,
                "already_revealed",
                "Votes have already been revealed.",
              );
            await sql.query(
              "UPDATE cloud_poker_rounds SET status='revealed',revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id],
            );
          } else if (input.kind === "close") {
            await sql.query(
              "UPDATE cloud_poker_rounds SET status='closed',revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id],
            );
          } else if (input.kind === "restart") {
            if (issue.archived)
              throw new CloudError(
                409,
                "issue_archived",
                "Restore the issue before restarting poker.",
              );
            const team = await requireTeam(sql, actor, issue.teamId);
            await sql.query(
              `UPDATE cloud_poker_rounds SET status='voting',revision=revision+1,generation=generation+1,issue_revision=$3,scale=$4,scale_revision=$5 WHERE organization_id=$1 AND id=$2`,
              [
                actor.organizationId,
                id,
                issue.revision,
                JSON.stringify(team.estimateScale),
                team.scaleRevision,
              ],
            );
          } else {
            if (round.status !== "revealed")
              throw new CloudError(
                409,
                "reveal_required",
                "Reveal the votes before recording an estimate.",
              );
            checkRevision(issue.revision, input.issueRevision);
            if (issue.revision !== round.issueRevision || issue.archived)
              throw new CloudError(
                409,
                "round_stale",
                "The issue changed. Restart the round before recording an estimate.",
              );
            const card = round.scale.find(
              (entry: EstimateCard) => entry.label === input.card,
            );
            if (!card || card.points === null)
              throw new CloudError(
                422,
                "invalid_estimate",
                "Choose a card with a point value.",
              );
            await sql.query(
              `UPDATE cloud_issues SET estimate=$3,estimate_points=$4,estimate_scale_revision=$5,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2`,
              [
                actor.organizationId,
                issue.id,
                card.label,
                card.points,
                round.scaleRevision,
              ],
            );
            await recordIssue(
              sql,
              actor,
              await readIssue(sql, actor, issue.id),
            );
            await sql.query(
              `UPDATE cloud_poker_rounds SET status='decided',decision=$3,rationale=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2`,
              [actor.organizationId, id, card.label, input.rationale],
            );
          }
          await recordEvent(
            sql,
            actor,
            `poker.${input.kind}`,
            id,
            round.revision + 1,
            { generation: round.generation },
          );
          return { id };
        },
      );
    });
  }
}
