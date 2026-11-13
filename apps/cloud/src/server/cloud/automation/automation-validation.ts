import type { CloudActor, CloudTeam } from "../../../lib/cloud-contract";
import type { AutomationInput } from "../../../lib/cloud-automation-contract";
import { CloudError, requireMembership } from "../access";
import type { CloudSql } from "../database";
import { readProfile } from "../execution/records";
import { readInferenceProvider } from "../ai/budgets";
import { readAutomation } from "./automation-records";

async function requireStatuses(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await sql.query(
    "SELECT id FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=$2 AND id=ANY($3::uuid[]) AND NOT archived",
    [actor.organizationId, teamId, ids],
  );
  if (found.rows.length !== new Set(ids).size)
    throw new CloudError(
      422,
      "status_unavailable",
      "Choose active statuses of this team.",
    );
}

async function requireLabels(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await sql.query(
    "SELECT id FROM cloud_labels WHERE organization_id=$1 AND team_id=$2 AND id=ANY($3::uuid[]) AND NOT archived",
    [actor.organizationId, teamId, ids],
  );
  if (found.rows.length !== new Set(ids).size)
    throw new CloudError(
      422,
      "label_unavailable",
      "Choose active labels of this team.",
    );
}

async function requireMember(
  sql: CloudSql,
  actor: CloudActor,
  userId: string,
): Promise<void> {
  const found = await sql.query(
    "SELECT 1 FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 AND active",
    [actor.organizationId, userId],
  );
  if (!found.rows.length)
    throw new CloudError(
      422,
      "member_unavailable",
      "Choose an active member of this organization.",
    );
}

async function requireModel(
  sql: CloudSql,
  actor: CloudActor,
  providerId: string,
  model: string,
): Promise<void> {
  const provider = await readInferenceProvider(
    sql,
    actor.organizationId,
    providerId,
  );
  if (!provider.models.includes(model))
    throw new CloudError(
      422,
      "model_unavailable",
      "Choose a configured model for this provider.",
    );
}

async function requireProducts(
  sql: CloudSql,
  actor: CloudActor,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await sql.query(
    "SELECT 1 FROM cloud_products WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND NOT archived",
    [actor.organizationId, ids],
  );
  if (found.rows.length !== new Set(ids).size)
    throw new CloudError(
      422,
      "product_unavailable",
      "Choose an active product.",
    );
}

async function requireRepositories(
  sql: CloudSql,
  actor: CloudActor,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await sql.query(
    "SELECT 1 FROM cloud_git_repositories WHERE organization_id=$1 AND id=ANY($2::uuid[])",
    [actor.organizationId, ids],
  );
  if (found.rows.length !== new Set(ids).size)
    throw new CloudError(
      422,
      "repository_unavailable",
      "Choose connected repositories.",
    );
}

async function requireAutomations(
  sql: CloudSql,
  actor: CloudActor,
  ids: string[],
  teamId: string | null,
): Promise<void> {
  if (!ids.length) return;
  for (const id of new Set(ids)) {
    const automation = await readAutomation(sql, actor, id);
    if (teamId && automation.teamId !== teamId)
      throw new CloudError(
        422,
        "automation_unavailable",
        "Choose automations of this team.",
      );
  }
}

async function requireProjects(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await sql.query(
    "SELECT 1 FROM cloud_projects WHERE organization_id=$1 AND team_id=$2 AND id=ANY($3::uuid[])",
    [actor.organizationId, teamId, ids],
  );
  if (found.rows.length !== new Set(ids).size)
    throw new CloudError(
      422,
      "project_unavailable",
      "Choose projects of this team.",
    );
}

export async function validateAutomation(
  sql: CloudSql,
  actor: CloudActor,
  team: CloudTeam,
  input: AutomationInput,
): Promise<void> {
  const { trigger } = input;
  if (trigger.kind === "status_changed")
    await requireStatuses(sql, actor, team.id, trigger.statusIds);
  if (trigger.kind === "label_added")
    await requireLabels(sql, actor, team.id, trigger.labelIds);
  if (trigger.kind === "release_created")
    await requireProducts(sql, actor, trigger.productIds);
  if (trigger.kind === "git_event")
    await requireRepositories(sql, actor, trigger.repositoryIds);
  if (trigger.kind === "automation_finished")
    await requireAutomations(sql, actor, trigger.automationIds, team.id);
  for (const action of input.actions) {
    switch (action.kind) {
      case "set_status":
        await requireStatuses(sql, actor, team.id, [action.statusId]);
        break;
      case "assign":
        if (!["trigger_actor", "unassigned"].includes(action.assignee))
          await requireMember(sql, actor, action.assignee);
        break;
      case "add_labels":
      case "remove_labels":
        await requireLabels(sql, actor, team.id, action.labelIds);
        break;
      case "create_issue":
        if (action.statusId)
          await requireStatuses(sql, actor, team.id, [action.statusId]);
        if (action.assigneeId)
          await requireMember(sql, actor, action.assigneeId);
        await requireLabels(sql, actor, team.id, action.labelIds);
        break;
      case "ask_agent":
      case "write_release_posts":
        await requireModel(sql, actor, action.providerId, action.model);
        break;
      case "delegate": {
        const profile = await readProfile(sql, actor, action.profileId);
        if (profile.teamId !== team.id || !profile.enabled)
          throw new CloudError(
            422,
            "profile_unavailable",
            "Choose an enabled execution profile of this team.",
          );
        break;
      }
      case "prepare_release":
        await requireProducts(sql, actor, [action.productId]);
        if (action.providerId)
          await requireModel(sql, actor, action.providerId, action.model);
        break;
      case "write_project_updates":
        await requireMembership(sql, actor, "ai.chat");
        await requireModel(sql, actor, action.providerId, action.model);
        await requireProjects(sql, actor, team.id, action.projectIds);
        break;
      case "run_automation":
      case "set_automation_enabled":
        await requireAutomations(sql, actor, [action.automationId], null);
        break;
      case "send_webhook":
        await requireMembership(sql, actor, "settings.manage");
        break;
      case "start_client_session":
        await requireMembership(sql, actor, "clients.manage");
        break;
    }
  }
}
