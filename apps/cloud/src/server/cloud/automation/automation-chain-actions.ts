import type { CloudActor } from "../../../lib/cloud-contract";
import type { AutomationAction } from "../../../lib/cloud-automation-contract";
import { maximumPulseProjects } from "../../../lib/cloud-pulse-contract";
import { readAutomation, insertAutomationRun } from "./automation-records";
import type { StoredAutomation } from "./automation-records";
import { maximumAutomationDepth } from "./automation-events";
import {
  skipped,
  succeeded,
  type ActiveRun,
  type AutomationServices,
  type StepOutcome,
} from "./automation-executor";

type ChainAction = Extract<
  AutomationAction,
  {
    kind: "run_automation" | "set_automation_enabled" | "write_project_updates";
  }
>;

export async function automationChainActions(
  services: AutomationServices,
  context: {
    run: ActiveRun;
    automation: StoredAutomation;
    owner: CloudActor;
    action: ChainAction;
    key: (purpose: string) => string;
  },
): Promise<StepOutcome> {
  const { run, automation, owner, action, key } = context;
  if (action.kind === "write_project_updates") {
    const projectIds = action.projectIds.length
      ? action.projectIds
      : (
          await services.database.transaction((sql) =>
            sql.query<{ id: string }>(
              `SELECT id FROM cloud_projects WHERE organization_id=$1 AND team_id=$2 AND status='active'
              ORDER BY lower(name),id LIMIT ${maximumPulseProjects}`,
              [owner.organizationId, automation.teamId],
            ),
          )
        ).rows.map((row) => row.id);
    if (!projectIds.length) return skipped("The team has no active projects.");
    await services.pulse.start(owner, key("pulse"), {
      projectIds,
      providerId: action.providerId,
      model: action.model,
    });
    return succeeded(
      `Agent is writing ${projectIds.length} ${projectIds.length === 1 ? "update" : "updates"}`,
      "/cloud/pulse",
    );
  }
  if (action.automationId === automation.id)
    return skipped("An automation cannot change or run itself.");
  if (action.kind === "set_automation_enabled") {
    const target = await services.automations.get(owner, action.automationId);
    if (target.enabled === action.enabled)
      return skipped(
        `${target.name} is already ${action.enabled ? "on" : "paused"}.`,
      );
    await services.automations.setEnabled(
      owner,
      key("automation-state"),
      target.id,
      { revision: target.revision, enabled: action.enabled },
    );
    return succeeded(
      `${action.enabled ? "Turned on" : "Paused"} ${target.name}`,
      "/cloud/automations",
    );
  }
  if (run.depth + 1 >= maximumAutomationDepth)
    return skipped("The chain of automations is too long.");
  return services.database.transaction(async (sql) => {
    const target = await readAutomation(sql, owner, action.automationId);
    if (!target.enabled) return skipped(`${target.name} is paused.`);
    const started = await insertAutomationRun(
      sql,
      owner.organizationId,
      target,
      {
        dedupeKey: `chain:${run.id}:${run.step}`,
        trigger: "automation",
        issueId: run.issueId,
        actorId: run.actorId,
        depth: run.depth + 1,
        variables: { run: { automation: automation.name } },
      },
    );
    return started
      ? succeeded(`Started ${target.name}`, "/cloud/automations")
      : skipped(`${target.name} reached its daily run limit.`);
  });
}
