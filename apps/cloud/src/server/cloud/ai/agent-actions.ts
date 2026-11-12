import type { CloudActor } from "../../../lib/cloud-contract";
import type { AgentAction } from "../../../lib/cloud-chat-contract";
import { CloudError, isCloudError } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudPlanning } from "../planning";
import type { CloudIssueRelations } from "../relations";
import type { CloudLabels } from "../labels";
import type { CloudIssueChanges } from "../issue-changes";
import type { CloudComments } from "../comments";
import type { CloudChatStore } from "./chat-store";
import type { CloudProjectUpdates } from "../project-updates";
import type { CloudTriage } from "../triage";

interface AgentActionServices {
  chat: CloudChatStore;
  planning: CloudPlanning;
  relations: CloudIssueRelations;
  labels: CloudLabels;
  issueChanges: CloudIssueChanges;
  comments: CloudComments;
  projectUpdates: CloudProjectUpdates;
  triage: CloudTriage;
}

const textChanges = ["title", "description", "acceptanceCriteria"] as const;

export class CloudAgentActions {
  constructor(private readonly services: AgentActionServices) {}

  async apply(
    actor: CloudActor,
    turnId: string,
    actionId: string,
  ): Promise<AgentAction> {
    const action = await this.services.chat.readAction(actor, turnId, actionId);
    if (action.state === "applied" || action.state === "dismissed")
      return action;
    try {
      const result = await this.perform(actor, action);
      return await this.services.chat.settleAction(actor, turnId, actionId, {
        state: "applied",
        error: null,
        result,
      });
    } catch (error) {
      if (!isCloudError(error) || error.status >= 500) throw error;
      return this.services.chat.settleAction(actor, turnId, actionId, {
        state: "failed",
        error:
          error.code === "revision_conflict"
            ? "This issue changed after the proposal. Ask Agent to propose the change again."
            : error.message,
        result: null,
      });
    }
  }

  async dismiss(
    actor: CloudActor,
    turnId: string,
    actionId: string,
  ): Promise<AgentAction> {
    const action = await this.services.chat.readAction(actor, turnId, actionId);
    if (action.state === "applied")
      throw new CloudError(
        409,
        "action_applied",
        "This proposal was already applied.",
      );
    return this.services.chat.settleAction(actor, turnId, actionId, {
      state: "dismissed",
      error: null,
      result: null,
    });
  }

  private async perform(
    actor: CloudActor,
    action: AgentAction,
  ): Promise<AgentAction["result"]> {
    const { planning, relations, labels, issueChanges, comments } =
      this.services;
    if (action.kind === "create_issue") {
      const created = action.parentId
        ? await relations.createChild(
            actor,
            derivedCommandId(action.id, "create"),
            action.parentId,
            {
              parentRevision: (await planning.getIssue(actor, action.parentId))
                .revision,
              issue: action.issue,
            },
          )
        : await planning.createIssue(
            actor,
            derivedCommandId(action.id, "create"),
            action.issue,
          );
      const issueId = created.id;
      if (action.labelIds.length) {
        const current = await labels.getIssue(actor, issueId);
        if (!current.labels.length)
          await labels.setIssue(
            actor,
            derivedCommandId(action.id, "labels"),
            issueId,
            {
              revision: current.revision,
              labelIds: action.labelIds,
            },
          );
      }
      const issue = await planning.getIssue(actor, issueId);
      return { kind: "issue", id: issue.id, label: issue.identifier };
    }
    if (action.kind === "update_issue") {
      const editsText = textChanges.some(
        (field) => action.changes[field] !== undefined,
      );
      if (Object.keys(action.changes).length)
        await issueChanges.apply(actor, derivedCommandId(action.id, "update"), {
          issues: [
            editsText
              ? { id: action.issueId, revision: action.revision }
              : { id: action.issueId },
          ],
          changes: action.changes,
        });
      if (action.labelIds) {
        const current = await labels.getIssue(actor, action.issueId);
        await labels.setIssue(
          actor,
          derivedCommandId(action.id, "labels"),
          action.issueId,
          { revision: current.revision, labelIds: action.labelIds },
        );
      }
      return { kind: "issue", id: action.issueId, label: action.identifier };
    }
    if (action.kind === "update_issues") {
      await issueChanges.apply(actor, derivedCommandId(action.id, "update"), {
        issues: action.issueIds.map((id) => ({ id })),
        changes: action.changes,
      });
      return {
        kind: action.issueIds.length === 1 ? "issue" : "issues",
        id: action.issueIds[0]!,
        label:
          action.identifiers.length > 3
            ? `${action.identifiers.length} issues`
            : action.identifiers.join(", "),
      };
    }
    if (action.kind === "link") {
      if (action.relationId)
        await relations.remove(
          actor,
          derivedCommandId(action.id, "link"),
          action.issueId,
          action.relationId,
        );
      else {
        const [source, target] = await Promise.all([
          planning.getIssue(actor, action.issueId),
          planning.getIssue(actor, action.targetId),
        ]);
        await relations.add(
          actor,
          derivedCommandId(action.id, "link"),
          action.issueId,
          {
            kind: action.relation,
            targetId: action.targetId,
            sourceRevision: source.revision,
            targetRevision: target.revision,
          },
        );
      }
      return { kind: "issue", id: action.issueId, label: action.identifier };
    }
    if (action.kind === "triage") {
      await this.services.triage.decide(
        actor,
        derivedCommandId(action.id, "triage"),
        action.issueId,
        action.decision,
      );
      return { kind: "issue", id: action.issueId, label: action.identifier };
    }
    if (action.kind === "project_update") {
      await this.services.projectUpdates.create(
        actor,
        derivedCommandId(action.id, "project-update"),
        action.projectId,
        { health: action.health, body: action.body },
      );
      return {
        kind: "project",
        id: action.projectId,
        label: action.projectName,
      };
    }
    await comments.create(
      actor,
      derivedCommandId(action.id, "comment"),
      action.issueId,
      action.body,
    );
    return { kind: "issue", id: action.issueId, label: action.identifier };
  }
}
