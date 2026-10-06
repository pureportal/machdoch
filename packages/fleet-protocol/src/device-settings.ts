import { z } from "zod";
import {
  operationEventsSchema,
  operationReadSchema,
  operationReleaseSchema,
  operationResponseSchema,
} from "@machdoch/fleet-protocol/operation";

import { deviceSettingsTransferCommands } from "@machdoch/fleet-protocol/device-settings-transfer";

export const deviceSettingsCapability = "device-settings.v1";
export const maximumDeviceSettingsRequestBodyBytes = 3_000_000;

export const deviceAppearanceSchema = z.strictObject({
  version: z.literal(1),
  theme: z.enum(["dark", "light"]),
  density: z.enum(["comfortable", "compact"]),
  accent: z.enum(["sky", "emerald", "violet", "amber"]),
});

export const deviceVoicePreferencesSchema = z.strictObject({
  supported: z.boolean(),
  systemVoicesSupported: z.boolean(),
  autoSpeakResponses: z.boolean(),
  availabilityDescription: z.string(),
  speechToTextAvailabilityDescription: z.string(),
  preferredVoiceURI: z.string().nullable(),
  rate: z.number().min(0.8).max(1.4),
  voiceOptions: z.array(
    z.strictObject({
      voiceURI: z.string(),
      label: z.string(),
      lang: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  speechInputDevicesSupported: z.boolean(),
  speechInputDevicesRefreshing: z.boolean(),
  speechInputDevices: z.array(
    z.strictObject({ deviceId: z.string(), label: z.string() }),
  ),
  speechInputDeviceError: z.string().nullable(),
});

export type DeviceVoicePreferences = z.infer<
  typeof deviceVoicePreferencesSchema
>;

const text = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"));
const provider = text.min(1).max(240);
const integer = z.number().int().min(0).max(3_600_000);
const desktopSettings = z.strictObject({
  autostartEnabled: z.boolean(),
  autostartMinimized: z.boolean(),
  autostartToTray: z.boolean(),
  alwaysRunAsAdministrator: z.boolean(),
  aiContextMaxMessages: integer,
  adaptiveControllerEnabled: z.boolean(),
  chatIdleTimeoutMinutes: integer,
  inactiveSessionArchiveDays: integer,
  archivedSessionRetentionDays: integer,
  quickVoiceEnabled: z.boolean(),
  quickVoiceShortcut: text.max(240),
  quickVoiceSilenceSeconds: z.number().min(0).max(60),
  quickVoiceMaxMessages: integer,
});
const agentLimits = z.strictObject({
  automaticRetries: z.boolean(),
  retryAttempts: integer,
  infinite: z.boolean(),
  executorTurns: integer,
  autopilotExecutorIterations: integer,
});
const workspaceRunSettings = z.strictObject({
  startupDelayMs: integer,
  healthCheckIntervalMs: integer,
  healthCheckTimeoutMs: integer,
  healthCheckFailureThreshold: integer,
  sequentialReadinessTimeoutMs: integer,
});
const reviewModel = z.strictObject({
  mode: z.enum(["base", "dedicated"]),
  provider: provider.optional(),
  model: text.optional(),
});
const internalTaskModel = z.strictObject({
  provider: provider.optional(),
  model: text.optional(),
  reasoning: provider,
});
const mcpDocument = z
  .string()
  .max(1_048_576)
  .refine((value) => !value.includes("\0"));
const noArgs = z.strictObject({});
const providerArgs = z.strictObject({ provider });
const apiKeyArgs = z.strictObject({ provider, apiKey: text.min(1) });
const enabledArgs = z.strictObject({ enabled: z.boolean() });

export const deviceSettingsCommands = {
  ...deviceSettingsTransferCommands,
  get_device_appearance: noArgs,
  save_device_appearance: z.strictObject({ settings: deviceAppearanceSchema }),
  get_device_voice_preferences: noArgs,
  refresh_device_speech_input_devices: noArgs,
  save_device_voice_preferences: z.strictObject({
    preferredVoiceURI: text.nullable(),
    rate: z.number().min(0.8).max(1.4),
    autoSpeakResponses: z.boolean(),
  }),
  get_global_provider_availability: noArgs,
  get_provider_model_catalog: noArgs,
  get_user_provider_api_keys: noArgs,
  get_user_answer_language: noArgs,
  get_user_web_search_settings: noArgs,
  get_user_voice_settings: noArgs,
  get_user_speech_to_text_settings: noArgs,
  get_user_desktop_settings: noArgs,
  get_user_memory_settings: noArgs,
  get_user_agent_limits_settings: noArgs,
  get_user_workspace_run_settings: noArgs,
  get_user_review_model_settings: noArgs,
  get_user_internal_task_model_settings: noArgs,
  get_user_mcp_config_document: noArgs,
  save_user_answer_language: z.strictObject({ language: text }),
  save_user_provider_api_key: apiKeyArgs,
  delete_user_provider_api_key: providerArgs,
  save_user_web_search_api_key: apiKeyArgs,
  delete_user_web_search_api_key: providerArgs,
  save_user_web_search_active_provider: providerArgs,
  save_user_voice_active_provider: providerArgs,
  save_user_speech_to_text_active_provider: providerArgs,
  save_user_speech_to_text_input_device: z.strictObject({
    inputDeviceId: text.nullable(),
  }),
  save_user_speech_to_text_key_terms: z.strictObject({
    keyTerms: z.array(text.max(240)).max(256),
  }),
  save_user_speech_to_text_context: z.strictObject({ speechContext: text }),
  save_user_speech_to_text_processing: z.strictObject({
    autoTranslateToEnglish: z.boolean(),
    autoFormat: z.boolean(),
  }),
  save_user_global_memory_enabled: enabledArgs,
  save_user_workspace_memory_default_enabled: enabledArgs,
  forget_user_global_memory_entry: z.strictObject({ id: text.min(1).max(240) }),
  save_user_desktop_settings: z.strictObject({ settings: desktopSettings }),
  save_user_agent_limits_settings: z.strictObject({ settings: agentLimits }),
  save_user_workspace_run_settings: z.strictObject({
    settings: workspaceRunSettings,
  }),
  save_user_review_model_settings: z.strictObject({ settings: reviewModel }),
  save_user_internal_task_model_settings: z.strictObject({
    settings: internalTaskModel,
  }),
  save_user_mcp_config_document: z.strictObject({
    raw: mcpDocument,
    expectedRaw: mcpDocument,
  }),
} as const;

export type DeviceSettingsCommand = keyof typeof deviceSettingsCommands;

export const deviceSettingsRequestSchema = z.union([
  z
    .strictObject({
      kind: z.literal("invoke"),
      id: z.string().uuid(),
      command: z.string(),
      args: z.unknown(),
    })
    .superRefine((request, context) => {
      const schema = Object.hasOwn(deviceSettingsCommands, request.command)
        ? deviceSettingsCommands[request.command as DeviceSettingsCommand]
        : null;
      if (!schema || !schema.safeParse(request.args).success)
        context.addIssue({
          code: "custom",
          message: "Invalid device settings operation.",
        });
    }),
  operationReadSchema,
  operationReleaseSchema,
  operationEventsSchema,
]);

export const deviceSettingsResponseSchema = operationResponseSchema;
