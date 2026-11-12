import { z } from "zod";
import { cloudId, revision, type IssueInput } from "./cloud-contract";
import type { IssueChangeSet } from "./cloud-issue-changes-contract";
import type { ProjectHealth } from "./cloud-project-update-contract";
import type { TriageDecision } from "./cloud-triage-contract";
import type { RelationKind } from "./cloud-relation-contract";

export const chatStates = [
  "queued",
  "running",
  "cancel_requested",
  "complete",
  "failed",
  "canceled",
  "unknown",
] as const;
export type ChatState = (typeof chatStates)[number];
export const activeChatStates = [
  "queued",
  "running",
  "cancel_requested",
] as const;
export const chatContextKinds = ["issue", "project", "cycle", "team"] as const;
export type ChatContextKind = (typeof chatContextKinds)[number];
export const maximumChatContext = 8;
export const chatContextReferenceSchema = z.strictObject({
  kind: z.enum(chatContextKinds),
  id: cloudId,
});
export type ChatContextReference = z.infer<typeof chatContextReferenceSchema>;
export const chatMessageSchema = z
  .strictObject({
    chatId: cloudId.nullable(),
    revision: revision.nullable(),
    providerId: cloudId,
    model: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    context: z
      .array(chatContextReferenceSchema)
      .max(maximumChatContext)
      .default([])
      .refine(
        (entries) =>
          new Set(entries.map((entry) => `${entry.kind}:${entry.id}`)).size ===
          entries.length,
        "Add each context item once.",
      ),
  })
  .refine((input) => (input.chatId === null) === (input.revision === null), {
    path: ["revision"],
    message: "Include the current conversation revision.",
  });
export const chatRetrySchema = z.strictObject({
  revision,
  providerId: cloudId,
  model: z.string().trim().min(1).max(160),
});
export type ChatRetryInput = z.infer<typeof chatRetrySchema>;
export const chatUpdateSchema = z
  .strictObject({
    revision,
    title: z.string().trim().min(1).max(120).optional(),
    archived: z.literal(true).optional(),
  })
  .refine((input) => input.title !== undefined || input.archived, {
    message: "Rename or archive the conversation.",
  });
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type ChatMessageInput = z.input<typeof chatMessageSchema>;
export type ChatMessage = z.output<typeof chatMessageSchema>;
export interface ChatContextEntity {
  kind: ChatContextKind;
  id: string;
  label: string;
  title: string | null;
  turnSequence: number;
}
export interface CloudChat {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  context: ChatContextEntity[];
}
export interface AgentStep {
  id: string;
  tool: string;
  label: string;
  failed: boolean;
}
export interface AgentQuestion {
  text: string;
  options: string[];
}
export const agentActionStates = [
  "pending",
  "applied",
  "dismissed",
  "failed",
] as const;
export type AgentActionState = (typeof agentActionStates)[number];
export interface AgentActionField {
  label: string;
  value: string;
  markdown?: true;
}
interface AgentActionBase {
  id: string;
  state: AgentActionState;
  title: string;
  fields: AgentActionField[];
  error: string | null;
  result: AgentActionResult | null;
}
export interface AgentActionResult {
  kind: "issue" | "issues" | "project";
  id: string;
  label: string;
}
export type AgentAction = AgentActionBase &
  (
    | {
        kind: "create_issue";
        issue: IssueInput;
        labelIds: string[];
        parentId: string | null;
      }
    | {
        kind: "update_issue";
        issueId: string;
        identifier: string;
        revision: number;
        changes: IssueChangeSet;
        labelIds?: string[];
      }
    | {
        kind: "update_issues";
        issueIds: string[];
        identifiers: string[];
        changes: IssueChangeSet;
      }
    | {
        kind: "link";
        issueId: string;
        identifier: string;
        targetId: string;
        targetIdentifier: string;
        relation: RelationKind;
        relationId: string | null;
      }
    | {
        kind: "comment";
        issueId: string;
        identifier: string;
        body: string;
      }
    | {
        kind: "triage";
        issueId: string;
        identifier: string;
        decision: TriageDecision;
      }
    | {
        kind: "project_update";
        projectId: string;
        projectName: string;
        health: ProjectHealth;
        body: string;
      }
  );
export interface CloudChatTurn {
  id: string;
  sequence: number;
  providerId: string;
  model: string;
  prompt: string;
  answer: string;
  state: ChatState;
  revision: number;
  errorCode: string | null;
  requestId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: AgentStep[];
  actions: AgentAction[];
  question: AgentQuestion | null;
}
export interface ChatDetail {
  chat: CloudChat;
  turns: CloudChatTurn[];
}
export interface ProviderBudget {
  providerId: string;
  budgetDay: string;
  usedTokens: number;
  reservedTokens: number;
  dailyTokenBudget: number;
  activeRequests: number;
  maxConcurrentRequests: number;
}
export const chatErrorMessages: Record<string, string> = {
  interrupted: "The response was interrupted. Retry when you are ready.",
  provider_unavailable:
    "The provider could not complete the response. Check the connection and retry.",
  provider_authentication:
    "The provider rejected its credentials. Ask an administrator to update the API key.",
  provider_access:
    "The provider denied access to this model. Ask an administrator to check provider permissions.",
  provider_billing:
    "The provider requires billing or additional access. Ask an administrator to check the account.",
  provider_model_unavailable:
    "The selected model is unavailable. Choose another configured model.",
  provider_rate_limited: "The provider is rate limited. Wait and retry.",
  response_incomplete:
    "The provider ended the response early. Send a follow-up to continue.",
  permission_changed:
    "Access to this provider changed. Choose an available provider for a new message.",
  budget_exceeded: "The provider's daily token budget is exhausted.",
  provider_busy:
    "This provider has no request slots available. Wait and retry.",
  output_limit_changed:
    "The provider output limit changed. Retry to use the new limit.",
  output_limit:
    "The response exceeded the output limit. Ask for a shorter answer.",
  unexpected_tools:
    "The provider requested a tool that is unavailable in this conversation.",
  credential_storage:
    "Provider credentials could not be unlocked. Contact your administrator.",
  cli_unavailable:
    "The CLI is not installed on the cloud host. Ask an administrator to install it.",
  cli_authentication:
    "The CLI is not signed in. Ask an administrator to sign in under AI providers.",
  cli_failed:
    "The CLI could not complete the response. Retry when you are ready.",
};
