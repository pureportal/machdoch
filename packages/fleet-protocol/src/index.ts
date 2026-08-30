import { z } from "zod";

export const gatewayProtocolVersion = 4;
export const maximumGatewayMessageBytes = 4 * 1024 * 1024;
export const productCapability = "product.v2";
export const productSnapshotVersion = 3;
export const managedSettingsSchemaVersion = 1;

export interface FleetManagedSettingsDefaults {
  preferredToolingAgent: string | null;
  provider: string | null;
  model: string | null;
  mode: string | null;
  reasoning: string | null;
  webSearchProvider: string | null;
  theme: string | null;
  density: string | null;
  accent: string | null;
}

export interface FleetManagedSettingsDocument {
  defaults: FleetManagedSettingsDefaults;
  agentLimits: {
    infinite: boolean | null;
    executorTurns: number | null;
    autopilotExecutorIterations: number | null;
  };
  instructions: Array<{
    id: string;
    name: string;
    body: string;
    enabled: boolean;
    global: boolean;
    tags: string[];
  }>;
  contextPacks: Array<{
    id: string;
    name: string;
    instructions: string;
    prompt: string;
    provider: string | null;
    model: string | null;
    mode: string | null;
    reasoning: string | null;
    variables: string[];
    triggerPhrases: string[];
    pathPatterns: string[];
  }>;
  customValues: Record<string, unknown>;
}

export interface FleetManagedSettingsDelivery {
  schemaVersion: typeof managedSettingsSchemaVersion;
  assigned: boolean;
  managerId?: string;
  profile?: {
    profileId: string;
    name: string;
    revision: number;
    document: FleetManagedSettingsDocument;
    secrets: Record<string, string>;
  };
}

const identifier = z.string().trim().min(1).max(240);
const commandId = z.string().trim().min(1).max(128).optional();
const shortText = z.string().trim().min(1).max(240);
const text = z.string().max(12_000);
const commandText = z.string().trim().min(1).max(8_000);
const workspace = z.string().trim().min(1).max(12_000);
const baseCommandShape = { commandId };
const sessionCommandShape = { ...baseCommandShape, sessionId: identifier };
const taskCommandShape = { ...baseCommandShape, taskId: identifier };
const schedulerCommandShape = {
  ...baseCommandShape,
  workspace,
};

const taskCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...taskCommandShape, kind: z.literal("cancel") }),
  z.strictObject({ ...taskCommandShape, kind: z.literal("retry") }),
  z.strictObject({ ...taskCommandShape, kind: z.literal("continue") }),
]);

const simpleSessionCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("activate-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("archive-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("pin-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("duplicate-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("branch-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("delete-session"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("clear-session-history"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("clear-session-mode"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("clear-session-reasoning"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("clear-attachments"),
  }),
]);

const schedulerJobCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-trigger"),
    jobId: identifier,
  }),
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-pause"),
    jobId: identifier,
  }),
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-resume"),
    jobId: identifier,
  }),
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-delete"),
    jobId: identifier,
  }),
]);

const schedulerRunCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-retry-run"),
    runId: identifier,
  }),
  z.strictObject({
    ...schedulerCommandShape,
    kind: z.literal("scheduler-cancel-run"),
    runId: identifier,
  }),
]);

export const productMediaTargetSchema = z.enum(["image", "svg"]);
export const productMediaAspectRatioSchema = z.enum([
  "1:1",
  "4:5",
  "16:9",
  "9:16",
]);
export const productMediaOutputFormatSchema = z.enum([
  "png",
  "jpeg",
  "webp",
  "svg",
]);

export const reasoningModeSchema = z.enum([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const promptEnhancementModeSchema = z.enum([
  "off",
  "simple",
  "web-search",
]);

export const productCommandSchema = z.discriminatedUnion("kind", [
  ...taskCommandSchema.options,
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("submit-message"),
    prompt: commandText,
    promptEnhancementMode: promptEnhancementModeSchema,
    interviewEnabled: z.boolean(),
  }),
  z.strictObject({
    ...baseCommandShape,
    kind: z.literal("create-session"),
    workspace: workspace.optional(),
  }),
  ...simpleSessionCommandSchema.options,
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("rename-session"),
    title: shortText,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("tag-session"),
    tags: z.array(z.string().trim().min(1).max(64)).max(24),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("update-draft"),
    prompt: z.string().max(8_000),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-session-model"),
    provider: shortText,
    model: shortText,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-session-mode"),
    mode: z.enum(["ask", "machdoch"]),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-session-reasoning"),
    reasoning: reasoningModeSchema,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-session-workspace"),
    workspace,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("clear-session-workspace"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-prompt-enhancement-mode"),
    promptEnhancementMode: promptEnhancementModeSchema,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-interview"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...taskCommandShape,
    kind: z.literal("cancel-prompt-enhancement"),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-session-memory"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-global-memory"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("set-ui-control"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("remove-attachment"),
    attachmentId: identifier,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("apply-context-pack"),
    contextPackId: identifier,
  }),
  z.strictObject({
    ...baseCommandShape,
    kind: z.literal("delete-context-pack"),
    contextPackId: identifier,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("save-message-context-pack"),
    messageId: identifier,
  }),
  z.strictObject({
    ...sessionCommandShape,
    kind: z.literal("speak-message"),
    messageId: identifier,
  }),
  z.strictObject({
    ...baseCommandShape,
    kind: z.literal("stop-speaking"),
  }),
  ...schedulerJobCommandSchema.options,
  ...schedulerRunCommandSchema.options,
  z.strictObject({
    ...baseCommandShape,
    kind: z.literal("generate-media"),
    prompt: commandText,
    target: productMediaTargetSchema,
    modelId: identifier,
    aspectRatio: productMediaAspectRatioSchema,
    outputCount: z.number().int().min(1).max(8),
    outputFormat: productMediaOutputFormatSchema,
    transparentBackground: z.boolean(),
  }),
  z.strictObject({
    ...baseCommandShape,
    kind: z.literal("cancel-media-run"),
    runId: identifier,
  }),
]);

export type ProductCommand = z.infer<typeof productCommandSchema>;
export type ProductCommandKind = ProductCommand["kind"];

const timestamp = z.number().int().nonnegative();
const optionalTimestamp = timestamp.optional();

export const productAttachmentSchema = z.discriminatedUnion("source", [
  z.strictObject({
    id: identifier,
    source: z.literal("path"),
    kind: shortText,
    name: text,
    path: text,
    parent: text.optional(),
  }),
  z.strictObject({
    id: identifier,
    source: z.literal("media-asset"),
    kind: shortText,
    name: text,
    workspaceRoot: workspace,
    assetId: identifier,
  }),
]);

export type ProductAttachment = z.infer<typeof productAttachmentSchema>;

export const productSessionSchema = z.strictObject({
  id: identifier,
  title: text,
  status: shortText,
  workspace: workspace.optional(),
  provider: z.string().max(240),
  model: z.string().max(240),
  mode: z.string().max(240).optional(),
  effectiveMode: z.string().max(240),
  reasoning: z.string().max(240).optional(),
  effectiveReasoning: z.string().max(240).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: optionalTimestamp,
  pinnedAt: optionalTimestamp,
  tags: z.array(z.string().max(64)).max(24),
  messageCount: z.number().int().nonnegative(),
  promptHistoryCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  runningTaskId: identifier.optional(),
  canRename: z.boolean(),
  canDelete: z.boolean(),
  canArchive: z.boolean(),
  canPin: z.boolean(),
  canDuplicate: z.boolean(),
  canBranch: z.boolean(),
  specialKind: z.string().max(240).optional(),
});

export type ProductSession = z.infer<typeof productSessionSchema>;

const traceEntrySchema = z.strictObject({
  label: text,
  detail: text,
  tone: z.string().max(240).optional(),
  timestamp: optionalTimestamp,
});

export const productMessageSchema = z.strictObject({
  id: identifier,
  role: z.string().max(64),
  content: text,
  createdAt: optionalTimestamp,
  taskId: identifier.optional(),
  taskAction: z
    .strictObject({
      kind: z.enum(["retry-task", "continue-task"]),
      objective: text,
    })
    .optional(),
  presentation: z.enum(["message", "prompt-enhancement"]),
  attachments: z.array(productAttachmentSchema).max(64),
  source: z
    .strictObject({
      kind: z.string().max(64),
      status: z.string().max(64).optional(),
      title: text.optional(),
      summary: text.optional(),
      mode: z.string().max(64).optional(),
      entries: z.array(traceEntrySchema).max(24),
      timeline: z.array(traceEntrySchema).max(40),
    })
    .optional(),
  actions: z.strictObject({
    canRetry: z.boolean(),
    canContinue: z.boolean(),
    canSaveAsContextPack: z.boolean(),
    canSpeak: z.boolean(),
    isSpeaking: z.boolean(),
  }),
});

export type ProductMessage = z.infer<typeof productMessageSchema>;

const runtimeCapabilitySchema = z.strictObject({
  available: z.boolean(),
  reason: text.optional(),
});

const schedulerJobSchema = z.strictObject({
  id: identifier,
  name: text,
  status: z.string().max(64),
  schedule: text,
  promptPreview: text,
  nextRunAt: optionalTimestamp,
  lastStartedAt: optionalTimestamp,
  lastFinishedAt: optionalTimestamp,
});

const schedulerRunSchema = z.strictObject({
  id: identifier,
  jobId: identifier,
  source: z.string().max(64),
  status: z.string().max(64),
  scheduledFor: timestamp,
  updatedAt: timestamp,
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  startedAt: optionalTimestamp,
  finishedAt: optionalTimestamp,
  nextAttemptAt: optionalTimestamp,
  error: text.optional(),
  summary: text.optional(),
});

const productModelProviderSchema = z.strictObject({
  provider: z.string().max(240),
  label: text,
  available: z.boolean(),
  error: text.optional(),
  models: z
    .array(
      z.strictObject({
        id: z.string().max(240),
        label: text,
      }),
    )
    .max(256),
});

const productMediaModelSchema = z.strictObject({
  id: identifier,
  label: text,
  target: z.enum(["local", "remote"]),
  targets: z.array(productMediaTargetSchema).min(1).max(2),
  recommended: z.boolean(),
  costHint: text.optional(),
});

const productMediaAssetSchema = z.strictObject({
  id: identifier,
  runId: identifier,
  kind: z.enum(["image", "video", "vector", "report"]),
  mimeType: z.string().max(80),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  createdAt: z.string().max(80),
  previewDataUrl: z
    .string()
    .max(120_000)
    .refine((value) => value.startsWith("data:image/"))
    .optional(),
  tags: z.array(z.string().max(80)).max(8),
});

const productMediaRunSchema = z.strictObject({
  id: identifier,
  status: z.enum([
    "queued",
    "running",
    "needs-review",
    "waiting-for-review",
    "canceling",
    "completed",
    "failed",
    "canceled",
  ]),
  createdAt: z.string().max(80),
  updatedAt: z.string().max(80),
  prompt: text,
  modelLabel: text,
  target: z.enum(["local", "remote"]).nullable(),
  outputCount: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  currentStep: text,
  error: text.optional(),
});

export const productMediaSchema = z.strictObject({
  loading: z.boolean(),
  error: text.optional(),
  runtimeMode: z.enum(["native", "browser-preview"]).optional(),
  generation: z.strictObject({
    prompt: z.string().max(8_000),
    target: productMediaTargetSchema,
    modelId: identifier.optional(),
    aspectRatio: productMediaAspectRatioSchema,
    outputCount: z.number().int().min(1).max(8),
    outputFormat: productMediaOutputFormatSchema,
    transparentBackground: z.boolean(),
    available: z.boolean(),
    unavailableReason: text.optional(),
  }),
  models: z.array(productMediaModelSchema).max(128),
  assets: z.array(productMediaAssetSchema).max(48),
  assetCount: z.number().int().nonnegative(),
  runs: z.array(productMediaRunSchema).max(80),
  runCount: z.number().int().nonnegative(),
  busy: z.boolean(),
  updatedAt: timestamp,
});

export type ProductMedia = z.infer<typeof productMediaSchema>;

export const productShellSchema = z.strictObject({
  version: z.literal(productSnapshotVersion),
  capturedAt: timestamp,
  activeSessionId: identifier.optional(),
  sessions: z.array(productSessionSchema).max(80),
  workspaces: z
    .array(
      z.strictObject({
        root: workspace,
        label: text,
        sessionCount: z.number().int().nonnegative(),
      }),
    )
    .max(40),
  visibleMessages: z.array(productMessageSchema).max(80),
  composer: z
    .strictObject({
      sessionId: identifier,
      draft: z.string().max(8_000),
      provider: z.string().max(240),
      providerLabel: text,
      model: z.string().max(240),
      modelLabel: text,
      modelCatalogLoading: z.boolean(),
      modelCatalog: z.array(productModelProviderSchema).max(32),
      mode: z.enum(["ask", "machdoch"]),
      defaultMode: z.enum(["ask", "machdoch"]),
      reasoning: reasoningModeSchema,
      defaultReasoning: reasoningModeSchema,
      reasoningOptions: z.array(reasoningModeSchema).min(1).max(9),
      promptEnhancementMode: promptEnhancementModeSchema,
      interviewEnabled: z.boolean(),
      interviewAvailable: z.boolean(),
      workspace: workspace.optional(),
      workspaceLabel: text,
      canSend: z.boolean(),
      sendDisabledReason: text.optional(),
      isExecuting: z.boolean(),
      sessionMemoryEnabled: z.boolean(),
      globalMemoryAvailable: z.boolean(),
      globalMemoryEnabled: z.boolean(),
      uiControlAvailable: z.boolean(),
      uiControlEnabled: z.boolean(),
      uiControlDescription: text,
      attachments: z.array(productAttachmentSchema).max(64),
      chooserProviders: z.array(z.string().max(240)).max(32),
      matchedContextPackIds: z.array(identifier).max(60),
    })
    .optional(),
  runtime: z
    .strictObject({
      loading: z.boolean(),
      error: text.optional(),
      hasAnyProvider: z.boolean(),
      providerStatuses: z
        .array(
          z.strictObject({
            provider: z.string().max(240),
            available: z.boolean(),
            reason: text.optional(),
          }),
        )
        .max(32),
      mode: z.string().max(240).optional(),
      reasoning: z.string().max(240).optional(),
      uiControl: runtimeCapabilitySchema.optional(),
      webSearch: runtimeCapabilitySchema.optional(),
    })
    .optional(),
  scheduler: z
    .strictObject({
      workspaceRoot: workspace.optional(),
      loading: z.boolean(),
      error: text.optional(),
      jobs: z.array(schedulerJobSchema).max(80),
      runs: z.array(schedulerRunSchema).max(120),
      updatedAt: timestamp,
    })
    .optional(),
  contextPacks: z
    .array(
      z.strictObject({
        id: identifier,
        name: text,
        scope: z.enum(["workspace", "global"]).optional(),
        scopeLabel: text.optional(),
        workspace: workspace.optional(),
        instructionsPreview: text,
        promptPreview: text,
        attachmentCount: z.number().int().nonnegative(),
        variables: z.array(z.string().max(240)).max(64),
        matched: z.boolean(),
        provider: z.string().max(240).optional(),
        model: z.string().max(240).optional(),
        mode: z.string().max(240).optional(),
        reasoning: z.string().max(240).optional(),
        promptEnhancementMode: z.string().max(240).optional(),
        interviewEnabled: z.boolean().optional(),
        sessionMemoryEnabled: z.boolean().optional(),
        useGlobalMemory: z.boolean().optional(),
        uiControlEnabled: z.boolean().optional(),
      }),
    )
    .max(60),
  instructions: z
    .strictObject({
      loading: z.boolean(),
      revision: z.number().int().nonnegative().optional(),
      error: text.optional(),
      profiles: z
        .array(
          z.strictObject({
            id: identifier,
            name: text,
            description: text.optional(),
            body: text.optional(),
            enabled: z.boolean(),
            global: z.boolean(),
            tags: z.array(z.string().max(80)).max(64),
          }),
        )
        .max(128),
    })
    .optional(),
  promptHistory: z.array(z.string().max(8_000)).max(30),
  voice: z
    .strictObject({
      supported: z.boolean(),
      autoSpeakResponses: z.boolean(),
      speakingMessageId: identifier.optional(),
      speechInputSupported: z.boolean(),
      speechInputEnabled: z.boolean(),
      speechInputStatus: text.optional(),
    })
    .optional(),
  quickTask: z
    .strictObject({
      status: z.string().max(64),
      draft: z.string().max(8_000),
      isExecuting: z.boolean(),
      provider: z.string().max(240),
      model: z.string().max(240),
      autopilotEnabled: z.boolean(),
      globalMemoryEnabled: z.boolean(),
      uiControlEnabled: z.boolean(),
      attachmentCount: z.number().int().nonnegative(),
    })
    .optional(),
  media: productMediaSchema.optional(),
});

export type ProductShell = z.infer<typeof productShellSchema>;

const taskSessionSchema = z.strictObject({
  taskId: identifier,
  task: text,
  mode: z.string().max(64),
  state: z.string().max(64),
  message: text,
  cancellable: z.boolean(),
  startedAt: timestamp,
  updatedAt: timestamp,
  progressCount: z.number().int().nonnegative(),
  logs: z.array(
    z.strictObject({
      createdAt: timestamp,
      stream: z.string().max(64),
      toolName: z.string().max(240).optional(),
      chunk: text,
    }),
  ),
  timeline: z.array(
    z.strictObject({
      createdAt: timestamp,
      kind: z.string().max(64),
      phase: z.string().max(64),
      label: text,
      detail: text.optional(),
      tone: z.string().max(64).optional(),
      toolName: z.string().max(240).optional(),
    }),
  ),
});

export const productSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  serverTime: timestamp,
  eventId: timestamp,
  sessions: z.array(taskSessionSchema).max(128),
  commands: z
    .array(
      z.strictObject({
        commandId: identifier,
        kind: z.string().max(64),
        taskId: identifier.optional(),
        sessionId: identifier.optional(),
        promptPreview: text.optional(),
        title: text.optional(),
        targetPreview: text.optional(),
        createdAt: timestamp,
      }),
    )
    .max(100),
  shell: productShellSchema.optional(),
});

export type ProductSnapshot = z.infer<typeof productSnapshotSchema>;

export const commandReceiptSchema = z.strictObject({
  commandId: identifier,
  duplicate: z.boolean(),
});

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export const hostRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("getProductSnapshot") }),
  z.strictObject({
    type: z.literal("executeProductCommand"),
    command: productCommandSchema,
  }),
]);

export type HostRequest = z.infer<typeof hostRequestSchema>;

export const hostResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("productSnapshot"),
    snapshot: productSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("commandAccepted"),
    receipt: commandReceiptSchema,
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum(["invalidRequest", "conflict", "unavailable", "internal"]),
    message: text,
  }),
]);

export type HostResponse = z.infer<typeof hostResponseSchema>;

export const managerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("request"),
    requestId: identifier,
    request: hostRequestSchema,
  }),
  z.strictObject({ type: z.literal("disconnect"), reason: text }),
]);

export type ManagerMessage = z.infer<typeof managerMessageSchema>;

export const hostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    instanceId: identifier,
    protocolVersion: z.literal(gatewayProtocolVersion),
    productVersion: z.string().trim().min(1).max(40),
    capabilities: z.array(z.string().min(1).max(64)).max(16),
  }),
  z.strictObject({ type: z.literal("heartbeat"), sentAt: timestamp }),
  z.strictObject({
    type: z.literal("response"),
    requestId: identifier,
    response: hostResponseSchema,
  }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
