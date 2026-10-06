import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
export const maximumComposerTextCharacters = 1_000_000;
const text = z.string().max(12_000);
const sessionCommandShape = {
  commandId: z.string().trim().min(1).max(128).optional(),
  sessionId: identifier,
};
const queuedMessageCommandShape = {
  ...sessionCommandShape,
  messageId: identifier,
};
const iterationCount = z.number().int().min(1).max(20);

export const productIterationModeSchema = z.enum([
  "repeat-prompt",
  "continue",
  "repeat-prompt-and-continue",
]);
export type ProductIterationMode = z.infer<typeof productIterationModeSchema>;

export const productRunningMessageActionSchema = z.enum([
  "queue",
  "steer",
  "stop-and-send",
]);
export type ProductRunningMessageAction = z.infer<
  typeof productRunningMessageActionSchema
>;

export const composerSubmitOptionsShape = {
  iterationCount: iterationCount.optional(),
  iterationMode: productIterationModeSchema.optional(),
  runningAction: productRunningMessageActionSchema.optional(),
};

export const contextPackVariableValuesSchema = z
  .record(z.string().max(240), text)
  .refine((values) => Object.keys(values).length <= 64);

export const composerCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("add-context-attachments"),
    paths: z
      .array(
        z
          .string()
          .min(1)
          .max(2048)
          .refine((value) => !value.includes("\0")),
      )
      .min(1)
      .max(64),
    messageId: identifier.optional(),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("update-queued-message"),
    prompt: z.string().max(maximumComposerTextCharacters),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("move-queued-message"),
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("reorder-queued-message"),
    targetIndex: z.number().int().min(0).max(511),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("remove-queued-message"),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("retry-queued-message"),
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("remove-queued-attachment"),
    attachmentId: identifier,
  }),
  z.strictObject({
    ...queuedMessageCommandShape,
    kind: z.literal("clear-queued-attachments"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-running-message-action"),
    runningAction: productRunningMessageActionSchema,
  }),
]);

export const productAttachmentSchema = z.discriminatedUnion("source", [
  z.strictObject({
    id: identifier,
    source: z.literal("path"),
    kind: z.enum(["file", "directory", "image", "other"]),
    name: text,
    path: text,
    parent: text.optional(),
  }),
  z.strictObject({
    id: identifier,
    source: z.literal("media-asset"),
    kind: z.enum([
      "prompt",
      "image",
      "video",
      "audio",
      "vector",
      "alpha-matte",
      "report",
      "collection",
    ]),
    displayName: text.optional(),
    rendition: z.enum(["thumbnail", "preview", "original"]).optional(),
    name: text,
    workspaceRoot: z.string().trim().min(1).max(12_000),
    assetId: identifier,
  }),
]);
export type ProductAttachment = z.infer<typeof productAttachmentSchema>;

export const productQueuedMessageIterationSchema = z.strictObject({
  groupId: identifier,
  index: iterationCount,
  total: iterationCount,
  mode: productIterationModeSchema,
});
export type ProductQueuedMessageIteration = z.infer<
  typeof productQueuedMessageIterationSchema
>;

export const productQueuedMessageSchema = z.strictObject({
  id: z.string().max(8_000),
  content: z.string().max(8_000),
  attachments: z.array(productAttachmentSchema).max(64),
  status: z.enum(["queued", "enhancing", "dispatching", "failed"]),
  createdAt: z.number().int().nonnegative(),
  iteration: productQueuedMessageIterationSchema.optional(),
  waitingForIteration: iterationCount.optional(),
  promptEnhancementMode: z.enum(["simple", "web-search"]).optional(),
  failureMessage: text.optional(),
});
export type ProductQueuedMessage = z.infer<typeof productQueuedMessageSchema>;

export const composerSnapshotShape = {
  queuedMessages: z.array(productQueuedMessageSchema).max(512).optional(),
  runningTaskMessageAction: productRunningMessageActionSchema.optional(),
  draftRevision: z.number().int().nonnegative().optional(),
  textTruncated: z.boolean().optional(),
  imageInputSupported: z.boolean().optional(),
  imageInputDisabledReason: text.optional(),
};
