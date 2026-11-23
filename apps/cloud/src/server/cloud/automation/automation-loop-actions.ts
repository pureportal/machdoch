import type { CloudActor } from "../../../lib/cloud-contract";
import type { AutomationAction } from "../../../lib/cloud-automation-contract";
import {
  renderAutomationText,
  type AutomationVariables,
} from "../../../lib/automation-text";
import {
  goalEvaluatorPrompt,
  goalWorkerPrompt,
  parseGoalVerdict,
} from "../../../lib/loop-outputs";
import { CloudError, requireMembership, teamVisibility } from "../access";
import { notifyLoop } from "../notifications";
import { recordTurnTokens } from "../loops/loop-runs";
import {
  insertAutomationRun,
  matchingIssueIds,
  readAutomation,
  type StoredAutomation,
} from "./automation-records";
import { maximumAutomationDepth } from "./automation-events";
import {
  skipped,
  succeeded,
  type ActiveRun,
  type AutomationServices,
  type StepOutcome,
} from "./automation-executor";

type LoopAction = Extract<
  AutomationAction,
  {
    kind:
      | "remember"
      | "request_input"
      | "goal"
      | "fan_out"
      | "append_document_section"
      | "notify";
  }
>;

export interface LoopActionContext {
  run: ActiveRun;
  automation: StoredAutomation;
  owner: CloudActor;
  variables: AutomationVariables;
  key: (purpose: string) => string;
  wait: () => Promise<"waiting">;
}

interface GoalState {
  iteration: number;
  phase: "work" | "evaluate";
  feedback: string;
  result: string;
}

interface FanOutState {
  automationId: string;
  issueIds: string[];
  started: number;
}

const maximumFanOutIssues = 50;
const notifyTimeoutMs = 10_000;

export async function loopMemory(
  services: AutomationServices,
  organizationId: string,
  loopId: string,
): Promise<Record<string, string>> {
  const rows = (
    await services.database.transaction((sql) =>
      sql.query<{ key: string; value: string }>(
        "SELECT key,value FROM cloud_loop_memory WHERE organization_id=$1 AND loop_id=$2 ORDER BY key",
        [organizationId, loopId],
      ),
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function executeLoopAction(
  services: AutomationServices,
  context: LoopActionContext,
  action: LoopAction,
): Promise<StepOutcome> {
  switch (action.kind) {
    case "remember":
      return remember(services, context, action);
    case "request_input":
      return requestInput(services, context, action);
    case "goal":
      return pursueGoal(services, context, action);
    case "fan_out":
      return fanOut(services, context, action);
    case "append_document_section":
      return appendDocumentSection(services, context, action);
    case "notify":
      return notify(services, context, action);
  }
}

async function remember(
  services: AutomationServices,
  { run, automation, variables }: LoopActionContext,
  action: Extract<LoopAction, { kind: "remember" }>,
): Promise<StepOutcome> {
  await services.database.transaction((sql) =>
    sql.query(
      `INSERT INTO cloud_loop_memory (organization_id,loop_id,key,value) VALUES ($1,$2,$3,$4)
      ON CONFLICT (organization_id,loop_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,
      [
        run.organizationId,
        automation.id,
        action.key,
        renderAutomationText(action.value, variables, 4_000),
      ],
    ),
  );
  return succeeded(`Remembered ${action.key}`);
}

async function requestInput(
  services: AutomationServices,
  { run, automation, variables, wait }: LoopActionContext,
  action: Extract<LoopAction, { kind: "request_input" }>,
): Promise<StepOutcome> {
  const pending = run.variables.loopInput as
    | { key: string; requestedAt: string }
    | undefined;
  if (!pending) {
    const requestedAt = await services.database.transaction(async (sql) => {
      await notifyLoop(sql, {
        organizationId: run.organizationId,
        userId: automation.ownerId,
        teamId: automation.teamId,
        kind: "loop_input",
        automationRunId: run.id,
        issueId: run.issueId,
        actorId: automation.ownerId,
        automation: automation.name,
        detail: renderAutomationText(action.prompt, variables, 2_000),
      });
      return (
        await sql.query<{ now: string }>(
          "SELECT clock_timestamp()::text AS now",
        )
      ).rows[0]!.now;
    });
    run.variables = {
      ...run.variables,
      loopInput: { key: action.key, requestedAt },
    };
    return wait();
  }
  const answer = (
    await services.database.transaction((sql) =>
      sql.query<{ value: string }>(
        "SELECT value FROM cloud_loop_memory WHERE organization_id=$1 AND loop_id=$2 AND key=$3 AND updated_at>$4::timestamptz",
        [run.organizationId, automation.id, pending.key, pending.requestedAt],
      ),
    )
  ).rows[0];
  if (!answer) return wait();
  const { loopInput: _answered, ...rest } = run.variables;
  run.variables = rest;
  return succeeded(`Received ${action.key}`);
}

async function agentAnswer(
  services: AutomationServices,
  { run, automation, owner }: LoopActionContext,
  turnKey: string,
  model: { providerId: string; model: string },
  prompt: string,
): Promise<string | "waiting"> {
  if (!run.turnId) {
    const submission = await services.chat.startHiddenChat(owner, turnKey, {
      owner: { automationId: automation.id },
      providerId: model.providerId,
      model: model.model,
      prompt,
      context: run.issueId
        ? [{ kind: "issue", id: run.issueId }]
        : [{ kind: "team", id: automation.teamId }],
    });
    run.chatId = submission.chatId;
    run.turnId = submission.turnId;
    run.agentActorId = owner.userId;
    return "waiting";
  }
  const turnId = run.turnId;
  const turn = (
    await services.database.transaction((sql) =>
      sql.query<{ state: string; answer: string; error_code: string | null }>(
        "SELECT state,answer,error_code FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
        [run.organizationId, turnId],
      ),
    )
  ).rows[0];
  if (!turn)
    throw new CloudError(
      409,
      "agent_unavailable",
      "The Agent conversation is unavailable.",
    );
  if (["queued", "running", "cancel_requested"].includes(turn.state))
    return "waiting";
  await services.database.transaction((sql) =>
    recordTurnTokens(sql, run.organizationId, run.id, turnId),
  );
  run.turnId = null;
  if (turn.state !== "complete")
    throw new CloudError(
      409,
      "agent_failed",
      `Agent did not finish${turn.error_code ? ` (${turn.error_code.replaceAll("_", " ")})` : ""}.`,
    );
  return turn.answer;
}

async function pursueGoal(
  services: AutomationServices,
  context: LoopActionContext,
  action: Extract<LoopAction, { kind: "goal" }>,
): Promise<StepOutcome> {
  const { run, variables, key, wait } = context;
  const objective = renderAutomationText(action.objective, variables, 8_000);
  const successCriteria = renderAutomationText(
    action.successCriteria,
    variables,
    4_000,
  );
  let state = (run.variables.goal as GoalState | undefined) ?? {
    iteration: 1,
    phase: "work",
    feedback: "",
    result: "",
  };
  for (;;) {
    const prompt =
      state.phase === "work"
        ? goalWorkerPrompt({ objective, successCriteria, ...state })
        : goalEvaluatorPrompt({
            objective,
            successCriteria,
            result: state.result,
          });
    const answer = await agentAnswer(
      services,
      context,
      key(`goal:${state.iteration}:${state.phase}`),
      action,
      prompt,
    );
    if (answer === "waiting") {
      run.variables = { ...run.variables, goal: state };
      return wait();
    }
    if (state.phase === "work") {
      state = { ...state, phase: "evaluate", result: answer };
      continue;
    }
    const verdict = parseGoalVerdict(answer);
    if (verdict.passed) {
      const { goal: _finished, ...rest } = run.variables;
      run.variables = { ...rest, agent: { answer: state.result } };
      return succeeded(
        `Goal met after ${state.iteration} ${state.iteration === 1 ? "iteration" : "iterations"}`,
        run.chatId ? `/cloud/chat/${run.chatId}` : null,
      );
    }
    if (state.iteration >= action.maxIterations)
      throw new CloudError(
        422,
        "goal_unmet",
        `Goal not met after ${state.iteration} ${state.iteration === 1 ? "iteration" : "iterations"}. ${verdict.feedback}`.trim(),
      );
    state = {
      iteration: state.iteration + 1,
      phase: "work",
      feedback: verdict.feedback,
      result: "",
    };
  }
}

async function fanOut(
  services: AutomationServices,
  { run, automation, owner, wait }: LoopActionContext,
  action: Extract<LoopAction, { kind: "fan_out" }>,
): Promise<StepOutcome> {
  if (action.automationId === automation.id)
    return skipped("A loop cannot fan out to itself.");
  if (run.depth + 1 >= maximumAutomationDepth)
    return skipped("The chain of automations is too long.");
  return services.database.transaction(async (sql) => {
    const target = await readAutomation(sql, owner, action.automationId);
    let state = run.variables.fanOut as FanOutState | undefined;
    if (!state) {
      if (!target.enabled) return skipped(`${target.name} is paused.`);
      const issueIds = await matchingIssueIds(
        sql,
        owner,
        { teamId: target.teamId, conditions: action.conditions },
        maximumFanOutIssues,
      );
      if (!issueIds.length) return skipped("No issues match.");
      state = { automationId: target.id, issueIds, started: 0 };
    }
    const children = (
      await sql.query<{ state: string }>(
        "SELECT state FROM cloud_automation_runs WHERE organization_id=$1 AND parent_run_id=$2",
        [run.organizationId, run.id],
      )
    ).rows;
    let active = children.filter((child) =>
      ["queued", "running", "waiting"].includes(child.state),
    ).length;
    while (active < action.concurrency && state.started < state.issueIds.length) {
      const issueId = state.issueIds[state.started]!;
      const started = await insertAutomationRun(
        sql,
        run.organizationId,
        target,
        {
          dedupeKey: `fanout:${run.id}:${issueId}`,
          trigger: "automation",
          issueId,
          actorId: run.actorId,
          depth: run.depth + 1,
          variables: { run: { automation: automation.name } },
          parentRunId: run.id,
          originRunId: run.id,
        },
      );
      if (started.id) active++;
      state = { ...state, started: state.started + 1 };
    }
    if (active || state.started < state.issueIds.length) {
      run.variables = { ...run.variables, fanOut: state };
      return wait();
    }
    const { fanOut: _done, ...rest } = run.variables;
    run.variables = rest;
    const failed = children.filter((child) => child.state === "failed").length;
    return {
      state: failed && failed === children.length ? "failed" : "succeeded",
      detail: `Ran ${target.name} on ${state.issueIds.length} ${state.issueIds.length === 1 ? "issue" : "issues"}${failed ? ` · ${failed} failed` : ""}`,
      link: `/cloud/loops/${target.id}`,
    };
  });
}

async function appendDocumentSection(
  services: AutomationServices,
  { run, owner, variables, key }: LoopActionContext,
  action: Extract<LoopAction, { kind: "append_document_section" }>,
): Promise<StepOutcome> {
  return services.database.transaction(async (sql) => {
    const document = (
      await sql.query<{ id: string }>(
        `SELECT d.id FROM cloud_documents d
        JOIN cloud_teams t ON t.organization_id=d.organization_id AND t.id=d.team_id
        JOIN cloud_memberships m ON m.organization_id=d.organization_id AND m.user_id=$3
        WHERE d.organization_id=$1 AND d.id=$2 AND ${teamVisibility} FOR UPDATE OF d`,
        [owner.organizationId, action.documentId, owner.userId],
      )
    ).rows[0];
    if (!document)
      throw new CloudError(
        422,
        "document_unavailable",
        "The document is unavailable. Edit the loop.",
      );
    await sql.query(
      `INSERT INTO cloud_document_sections (organization_id,id,document_id,position,heading,body,automation_run_id)
      SELECT $1,$2,$3,COALESCE(max(position),0)+1,$4,$5,$6 FROM cloud_document_sections WHERE organization_id=$1 AND document_id=$3
      ON CONFLICT (organization_id,id) DO NOTHING`,
      [
        owner.organizationId,
        key("section"),
        document.id,
        renderAutomationText(action.heading, variables, 200).trim() ||
          String(variables.date),
        renderAutomationText(action.body, variables, 50_000),
        run.id,
      ],
    );
    await sql.query(
      "UPDATE cloud_documents SET updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
      [owner.organizationId, document.id],
    );
    return succeeded("Section added", `/cloud/documents/${document.id}`);
  });
}

async function notify(
  services: AutomationServices,
  { run, automation, owner, variables }: LoopActionContext,
  action: Extract<LoopAction, { kind: "notify" }>,
): Promise<StepOutcome> {
  const subject = renderAutomationText(action.subject, variables, 200).trim();
  const body = renderAutomationText(action.body, variables, 20_000).trim();
  if (action.channel === "email") {
    const delivered = await services.database.transaction(async (sql) => {
      const recipient = (
        await sql.query<{ id: string }>(
          `SELECT u.id FROM cloud_users u JOIN cloud_memberships m ON m.organization_id=$1 AND m.user_id=u.id
          WHERE lower(u.email)=lower($2)`,
          [run.organizationId, action.target],
        )
      ).rows[0];
      if (!recipient) return false;
      await notifyLoop(sql, {
        organizationId: run.organizationId,
        userId: recipient.id,
        teamId: automation.teamId,
        kind: "loop_message",
        automationRunId: run.id,
        issueId: run.issueId,
        actorId: automation.ownerId,
        automation: automation.name,
        detail: subject ? `${subject}\n\n${body}` : body,
      });
      return true;
    });
    if (!delivered)
      throw new CloudError(
        422,
        "recipient_unavailable",
        "The recipient is not a member of this workspace.",
      );
    return succeeded(`Sent to ${action.target}`);
  }
  await services.database.transaction((sql) =>
    requireMembership(sql, owner, "settings.manage"),
  );
  let response: Response;
  try {
    response = await services.fetch(action.target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "machdoch-cloud-automation",
      },
      body: JSON.stringify({ text: subject ? `${subject}\n\n${body}` : body }),
      redirect: "error",
      signal: AbortSignal.timeout(notifyTimeoutMs),
    });
  } catch {
    throw new CloudError(
      422,
      "notify_unreachable",
      "The notification address could not be reached.",
    );
  }
  if (!response.ok)
    throw new CloudError(
      422,
      "notify_rejected",
      `The notification address responded with status ${response.status}.`,
    );
  return succeeded(
    `Posted to ${action.channel === "slack" ? "Slack" : "Teams"}`,
  );
}
