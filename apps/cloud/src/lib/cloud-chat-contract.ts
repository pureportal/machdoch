import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";

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
export const chatMessageSchema = z
  .strictObject({
    chatId: cloudId.nullable(),
    revision: revision.nullable(),
    providerId: cloudId,
    model: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    issueId: cloudId.optional(),
  })
  .refine((input) => (input.chatId === null) === (input.revision === null), {
    path: ["revision"],
    message: "Include the current conversation revision.",
  })
  .refine((input) => input.chatId === null || !input.issueId, {
    path: ["issueId"],
    message: "Choose the issue when starting a conversation.",
  });
export const chatRetrySchema = z.strictObject({
  revision,
  providerId: cloudId,
  model: z.string().trim().min(1).max(160),
});
export type ChatRetryInput = z.infer<typeof chatRetrySchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export interface CloudChat {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  issueId: string | null;
}
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
    "The CLI is not signed in on the cloud host. Ask an administrator to sign in or add an API key.",
  cli_failed: "The CLI could not complete the response. Retry when you are ready.",
};
