import { randomUUID } from "node:crypto";
import type { GitEvent, GitEventKind } from "../../../lib/git-events";
import type { GitProvider } from "../../../lib/git-providers";
import { automationScope } from "../automation/automation-events";
import type { CloudSql } from "../database";
import { usersForLogins } from "./accounts";

export type StoredRepository = {
  id: string;
  provider: GitProvider;
  fullName: string;
  defaultBranch: string;
  webUrl: string | null;
};

export interface EventConnection {
  organizationId: string;
  provider: GitProvider;
  apiUrl: string;
}

export function gitEvent(
  repository: StoredRepository,
  kind: GitEventKind,
  fields: Partial<GitEvent>,
): GitEvent {
  return {
    kind,
    provider: repository.provider,
    repositoryId: repository.id,
    repository: repository.fullName,
    repositoryUrl: repository.webUrl,
    defaultBranch: repository.defaultBranch,
    branch: null,
    sender: null,
    pullRequest: null,
    push: null,
    review: null,
    comment: null,
    tag: null,
    parent: null,
    issueIds: [],
    ...fields,
  };
}

export async function queueGitEvents(
  sql: CloudSql,
  connection: EventConnection,
  events: readonly GitEvent[],
): Promise<void> {
  if (!events.length) return;
  const subscribed = await sql.query(
    "SELECT 1 FROM cloud_automations WHERE organization_id=$1 AND enabled AND trigger_kind='git_event' LIMIT 1",
    [connection.organizationId],
  );
  if (!subscribed.rows.length) return;
  const senders = [
    ...new Set(events.flatMap((event) => (event.sender ? [event.sender] : []))),
  ];
  const users = await usersForLogins(
    sql,
    connection.organizationId,
    connection.provider,
    connection.apiUrl,
    senders,
  );
  const scope = automationScope.getStore();
  for (const event of events)
    await sql.query(
      "INSERT INTO cloud_automation_events (organization_id,id,team_id,issue_id,actor_id,event,depth,origin_automation_id) VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6)",
      [
        connection.organizationId,
        randomUUID(),
        (event.sender && users.get(event.sender.toLowerCase())) ?? null,
        JSON.stringify({ kind: "git_event", git: event }),
        scope?.depth ?? 0,
        scope?.automationId ?? null,
      ],
    );
}
