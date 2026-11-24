import type { CloudActor } from "../../../lib/cloud-contract";
import type { PullRequestFixTask } from "../../../lib/pull-request-fixes";
import { CloudError } from "../access";
import type { CloudDatabase } from "../database";
import type { CloudGitPullRequests } from "../git/pull-requests";
import { admitRun } from "./admission";
import { pullRequestProfileId } from "./pull-request-tasks";
import { lockExecution } from "./records";

export class CloudPullRequestFixes {
  constructor(
    private readonly database: CloudDatabase,
    private readonly pullRequests: CloudGitPullRequests,
  ) {}

  async start(
    actor: CloudActor,
    key: string,
    pullRequestId: string,
    task: PullRequestFixTask,
  ): Promise<{ id: string }> {
    const subject = await this.pullRequests.fixSubject(
      actor,
      pullRequestId,
      task,
    );
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const profileId = await pullRequestProfileId(sql, actor, pullRequestId);
      if (!profileId)
        throw new CloudError(
          422,
          "profile_missing",
          "Add an execution profile for this repository under Settings → Execution.",
        );
      const running = await sql.query(
        `SELECT 1 FROM cloud_runs WHERE organization_id=$1 AND state NOT IN ('succeeded','failed','canceled','timed_out')
        AND manifest->'subject'->>'kind'='pull_request' AND manifest->'subject'->>'id'=$2 AND manifest->'subject'->>'purpose' IN ('fix','resolve')
        AND NOT EXISTS (SELECT 1 FROM cloud_command_receipts c WHERE c.organization_id=$1 AND c.actor_id=$3 AND c.command_id=$4)`,
        [actor.organizationId, pullRequestId, actor.userId, key],
      );
      if (running.rows.length)
        throw new CloudError(
          409,
          "fix_running",
          "A fix is already running on this pull request.",
        );
      return admitRun(sql, actor, key, {
        profileId,
        subject: {
          kind: "pull_request",
          purpose: "fix",
          id: pullRequestId,
          ...subject,
        },
      });
    });
  }
}
