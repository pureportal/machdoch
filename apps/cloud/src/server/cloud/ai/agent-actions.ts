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
import type { CloudReleases } from "../releases/releases";
import type { CloudReleaseStudio } from "../releases/release-studio";
import type { CloudAutomations } from "../automation/automations";
import type { CloudAttachments } from "../attachments/attachments";
import { uploadInstructions } from "../attachments/upload-instructions";
import { clientSessionHref, type CloudClients } from "../clients/clients";
import {
  attachmentUrl,
  referencedAttachmentIds,
} from "../../../lib/cloud-attachment-contract";

interface AgentActionServices {
  origin: string;
  attachments: CloudAttachments;
  clients: CloudClients;
  automations: CloudAutomations;
  chat: CloudChatStore;
  planning: CloudPlanning;
  relations: CloudIssueRelations;
  labels: CloudLabels;
  issueChanges: CloudIssueChanges;
  comments: CloudComments;
  projectUpdates: CloudProjectUpdates;
  triage: CloudTriage;
  releases: CloudReleases;
  studio: CloudReleaseStudio;
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
            ? "This item changed after the proposal. Ask Agent to propose the change again."
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

  private async adoptAttachments(
    actor: CloudActor,
    actionId: string,
    issueId: string | null,
    explicit: string[] | undefined,
    texts: (string | undefined)[],
  ): Promise<{
    rewrite: <T extends string | undefined>(text: T) => T;
    copy: (targetId: string) => Promise<void>;
  }> {
    const { attachments } = this.services;
    const existing = new Set(
      issueId
        ? (await attachments.list(actor, issueId)).map((entry) => entry.id)
        : [],
    );
    const sources = [
      ...new Set([
        ...(explicit ?? []),
        ...texts.flatMap((text) => (text ? referencedAttachmentIds(text) : [])),
      ]),
    ].filter((id) => !existing.has(id));
    await Promise.all(sources.map((id) => attachments.get(actor, id)));
    const copies = new Map(
      sources.map((id) => [id, derivedCommandId(actionId, `attachment:${id}`)]),
    );
    return {
      rewrite: (text) =>
        text?.replace(
          /\/api\/v1\/attachments\/([0-9a-f-]{36})/gi,
          (match, id: string) => {
            const copy = copies.get(id.toLowerCase());
            return copy ? attachmentUrl(copy) : match;
          },
        ) as typeof text,
      copy: async (targetId) => {
        for (const [source, copy] of copies)
          await attachments.copyToIssue(actor, source, targetId, copy);
      },
    };
  }

  private async startClientSession(
    actor: CloudActor,
    action: Extract<AgentAction, { kind: "client_session" }>,
  ): Promise<AgentAction["result"]> {
    const { attachments, clients, origin } = this.services;
    const upload = action.issueId
      ? await attachments.createUploadLink(actor, action.issueId)
      : null;
    const prompt = upload
      ? `${action.prompt}\n\n${uploadInstructions(
          `${origin}/api/v1/attachment-uploads/${upload.token}`,
          action.identifier ?? "the issue",
        )}`
      : action.prompt;
    const started = await clients.start(
      actor,
      derivedCommandId(action.id, "client-session"),
      {
        instanceId: action.instanceId,
        workspace: action.workspace,
        title: action.sessionTitle,
        prompt,
        goalObjective: action.goal ? action.prompt.slice(0, 4_000) : null,
      },
      AbortSignal.timeout(60_000),
    );
    return {
      kind: "client_session",
      id: started.sessionId,
      label: started.displayName,
      href: clientSessionHref(started),
    };
  }

  private async configureAutomation(
    actor: CloudActor,
    action: Extract<AgentAction, { kind: "automation" }>,
  ): Promise<AgentAction["result"]> {
    const { automations } = this.services;
    const { id } = action.automationId
      ? await automations.update(
          actor,
          derivedCommandId(action.id, "automation"),
          action.automationId,
          { revision: action.revision!, automation: action.automation },
        )
      : await automations.create(
          actor,
          derivedCommandId(action.id, "automation"),
          action.automation,
        );
    const saved = await automations.get(actor, id);
    if (saved.enabled !== action.enabled)
      await automations.setEnabled(
        actor,
        derivedCommandId(action.id, "automation-state"),
        id,
        { revision: saved.revision, enabled: action.enabled },
      );
    return { kind: "automation", id, label: action.automation.name };
  }

  private async perform(
    actor: CloudActor,
    action: AgentAction,
  ): Promise<AgentAction["result"]> {
    const { planning, relations, labels, issueChanges, comments } =
      this.services;
    if (action.kind === "create_issue") {
      const adopted = await this.adoptAttachments(
        actor,
        action.id,
        null,
        action.attachmentIds,
        [action.issue.description, action.issue.acceptanceCriteria],
      );
      const issueInput = {
        ...action.issue,
        description: adopted.rewrite(action.issue.description),
        acceptanceCriteria: adopted.rewrite(action.issue.acceptanceCriteria),
      };
      const created = action.parentId
        ? await relations.createChild(
            actor,
            derivedCommandId(action.id, "create"),
            action.parentId,
            {
              parentRevision: (await planning.getIssue(actor, action.parentId))
                .revision,
              issue: issueInput,
            },
          )
        : await planning.createIssue(
            actor,
            derivedCommandId(action.id, "create"),
            issueInput,
          );
      const issueId = created.id;
      await adopted.copy(issueId);
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
      const adopted = await this.adoptAttachments(
        actor,
        action.id,
        action.issueId,
        action.attachmentIds,
        [action.changes.description, action.changes.acceptanceCriteria],
      );
      await adopted.copy(action.issueId);
      if (Object.keys(action.changes).length)
        await issueChanges.apply(actor, derivedCommandId(action.id, "update"), {
          issues: [
            editsText
              ? { id: action.issueId, revision: action.revision }
              : { id: action.issueId },
          ],
          changes: {
            ...action.changes,
            ...(action.changes.description !== undefined
              ? { description: adopted.rewrite(action.changes.description) }
              : {}),
            ...(action.changes.acceptanceCriteria !== undefined
              ? {
                  acceptanceCriteria: adopted.rewrite(
                    action.changes.acceptanceCriteria,
                  ),
                }
              : {}),
          },
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
    if (action.kind === "release_notes") {
      const release = await this.services.releases.get(actor, action.releaseId);
      await this.services.releases.update(
        actor,
        derivedCommandId(action.id, "release-notes"),
        action.releaseId,
        {
          revision: action.revision,
          version: release.version,
          name: release.name,
          targetDate: release.targetDate,
          summary: action.summary,
          notes: action.notes,
          highlights: action.highlights,
        },
      );
      return {
        kind: "release",
        id: action.releaseId,
        label: action.releaseLabel,
      };
    }
    if (action.kind === "release_post") {
      const release = await this.services.releases.get(actor, action.releaseId);
      const post = release.posts.find((entry) => entry.id === action.postId);
      if (!post)
        throw new CloudError(
          404,
          "not_found",
          "The channel post is unavailable.",
        );
      await this.services.releases.updatePost(
        actor,
        derivedCommandId(action.id, "release-post"),
        action.postId,
        {
          revision: post.revision,
          title: action.postTitle,
          body: action.body,
          mediaIds: action.mediaIds,
          link: action.link,
        },
      );
      return {
        kind: "release",
        id: action.releaseId,
        label: action.releaseLabel,
      };
    }
    if (action.kind === "release_visual") {
      const media = await this.services.studio.createVisual(
        actor,
        action.releaseId,
        action.visual,
      );
      if (action.attachPostIds.length) {
        const release = await this.services.releases.get(
          actor,
          action.releaseId,
        );
        for (const post of release.posts.filter((entry) =>
          action.attachPostIds.includes(entry.id),
        ))
          await this.services.releases.updatePost(
            actor,
            derivedCommandId(`${action.id}:${post.id}`, "release-visual"),
            post.id,
            {
              revision: post.revision,
              title: post.title,
              body: post.body,
              mediaIds: [media.id, ...post.mediaIds].slice(0, 9),
              link: post.link,
            },
          );
      }
      return {
        kind: "release",
        id: action.releaseId,
        label: action.releaseLabel,
      };
    }
    if (action.kind === "automation")
      return this.configureAutomation(actor, action);
    if (action.kind === "client_session")
      return this.startClientSession(actor, action);
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
    const adopted = await this.adoptAttachments(
      actor,
      action.id,
      action.issueId,
      action.attachmentIds,
      [action.body],
    );
    await adopted.copy(action.issueId);
    await comments.create(
      actor,
      derivedCommandId(action.id, "comment"),
      action.issueId,
      adopted.rewrite(action.body),
    );
    return { kind: "issue", id: action.issueId, label: action.identifier };
  }
}
