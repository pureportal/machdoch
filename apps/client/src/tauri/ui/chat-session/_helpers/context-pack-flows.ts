import { replaceChatInputNeededPlaceholders } from "@machdoch/client-ui/composer/chat-input-needed-placeholders";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import type { PromptEnhancementMode } from "@machdoch/client-ui/composer/prompt-enhancement-options";
import { cloneContextAttachmentsForPack } from "@machdoch/client-ui/context-packs/helpers";
import type { SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import type {
  ChatSessionQueuedMessage,
  ChatSessionRecord,
} from "../../chat-session.model";
import type { RuntimeProvider } from "../../model-catalog";
import { createQueuedPromptEnhancementRequest } from "./prompt-enhancement";
import { createSessionMessageSettings } from "./session-message-settings";
import {
  applySmartContextPackSettingsToSession,
  createSmartContextPackDraftBlock,
  getSmartContextPackModelSelection,
} from "./smart-context-packs";

export interface ContextPackFlowRunStep {
  pack: SmartContextPack;
  contextAttachments: ChatSessionContextAttachment[];
}

export const createContextPackFlowStepTask = (
  pack: SmartContextPack,
  valuesByLookupKey: Record<string, string>,
): string => {
  const packValues: Record<string, string> = {};

  for (const variable of pack.variables) {
    const value = valuesByLookupKey[variable.name.toLowerCase()];

    if (value !== undefined) {
      packValues[variable.name] = value;
    }
  }

  const block =
    createSmartContextPackDraftBlock(pack, packValues) ||
    `## Context Pack: ${pack.name}`;

  return replaceChatInputNeededPlaceholders(block, valuesByLookupKey).trim();
};

export const createQueuedContextPackFlowSteps = (input: {
  session: ChatSessionRecord;
  flowName: string;
  steps: ContextPackFlowRunStep[];
  valuesByLookupKey: Record<string, string>;
  availableProviders: readonly RuntimeProvider[];
  promptEnhancementMode: PromptEnhancementMode;
  orderRank: number;
  timestamp: number;
}): ChatSessionQueuedMessage[] => {
  const groupId = crypto.randomUUID();
  const total = input.steps.length;

  return input.steps.map(({ pack, contextAttachments }, offset) => {
    const task = createContextPackFlowStepTask(pack, input.valuesByLookupKey);
    const promptEnhancementMode =
      pack.promptEnhancementMode ?? input.promptEnhancementMode;
    const promptEnhancementRequest = createQueuedPromptEnhancementRequest(
      promptEnhancementMode,
    );
    const stepSession = applySmartContextPackSettingsToSession(
      input.session,
      pack,
      getSmartContextPackModelSelection(pack, input.availableProviders),
    );

    return {
      id: crypto.randomUUID(),
      sessionId: input.session.id,
      task,
      visibleMessageContent: task,
      promptHistoryContent: task,
      ...(promptEnhancementRequest ? { promptEnhancementRequest } : {}),
      settings: createSessionMessageSettings(
        stepSession,
        promptEnhancementMode,
        pack.interviewEnabled ?? false,
      ),
      iteration: {
        groupId,
        index: offset + 1,
        total,
        label: input.flowName,
      },
      contextAttachments: cloneContextAttachmentsForPack(contextAttachments),
      contentUpdatedAt: input.timestamp,
      attachmentsUpdatedAt: input.timestamp,
      attachmentTombstones: {},
      blockerUpdatedAt: input.timestamp,
      orderRank: input.orderRank + offset,
      orderUpdatedAt: input.timestamp,
      status: "queued" as const,
      statusUpdatedAt: input.timestamp,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
  });
};
