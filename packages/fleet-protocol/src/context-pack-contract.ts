import { z } from "zod";
import { productAttachmentSchema } from "@machdoch/fleet-protocol/composer-contract";
import {
  modelProviderSchema,
  runModeSchema,
  reasoningModeSchema,
  promptEnhancementModeSchema,
} from "@machdoch/fleet-protocol/runtime-options";

export const contextPackLimits = {
  documents: 160,
  text: 128 * 1024,
  identifier: 240,
  variables: 64,
  triggers: 128,
  triggerPathPattern: 2048,
} as const;

const id = z.string().trim().min(1).max(contextPackLimits.identifier);
const text = z
  .string()
  .max(contextPackLimits.text)
  .refine((value) => !value.includes("\0"));
const variable = z.strictObject({ name: id, defaultValue: text.optional() });
const overrides = {
  provider: modelProviderSchema.optional(),
  model: id.optional(),
  mode: runModeSchema.optional(),
  reasoning: reasoningModeSchema.optional(),
  promptEnhancementMode: promptEnhancementModeSchema.optional(),
  interviewEnabled: z.boolean().optional(),
  sessionMemoryEnabled: z.boolean().optional(),
  useWorkspaceMemory: z.boolean().optional(),
  useGlobalMemory: z.boolean().optional(),
  uiControlEnabled: z.boolean().optional(),
};
const content = {
  name: id,
  instructions: text,
  prompt: text,
  contextAttachments: z.array(productAttachmentSchema).max(64),
};
export const contextPackScopeSchema = z.enum(["workspace", "global"]);
export const contextPackDefinitionSchema = z.strictObject({
  ...overrides,
  ...content,
  id: id.optional(),
  scope: contextPackScopeSchema,
  variables: z.array(z.union([id, variable])).max(contextPackLimits.variables),
  triggerPhrases: z.array(id).max(contextPackLimits.triggers),
  triggerPathPatterns: z
    .array(z.string().max(contextPackLimits.triggerPathPattern))
    .max(contextPackLimits.triggers),
});
export const contextPackDocumentSchema = z.strictObject({
  ...overrides,
  ...content,
  id,
  workspace: z.string().min(1).max(2048).nullable(),
  variables: z.array(variable).max(contextPackLimits.variables),
  trigger: z.strictObject({
    phrases: z.array(id).max(contextPackLimits.triggers),
    pathPatterns: z
      .array(z.string().max(contextPackLimits.triggerPathPattern))
      .max(contextPackLimits.triggers),
  }),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().optional(),
  useCount: z.number().int().nonnegative(),
});
export const contextPackDocumentsSchema = z
  .array(contextPackDocumentSchema)
  .max(contextPackLimits.documents);
export const contextPackExportSchema = z.strictObject({
  kind: z.literal("machdoch.context-packs"),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  contextPacks: contextPackDocumentsSchema,
});
export const contextPackCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("save-context-pack"),
    commandId: z.string().trim().min(1).max(128).optional(),
    sessionId: id,
    contextPack: contextPackDefinitionSchema,
  }),
  z.strictObject({
    kind: z.literal("import-context-packs"),
    commandId: z.string().trim().min(1).max(128).optional(),
    sessionId: id,
    scope: contextPackScopeSchema,
    paths: z
      .array(
        z
          .string()
          .min(1)
          .max(2048)
          .refine((value) => !value.includes("\0")),
      )
      .length(1),
  }),
]);
