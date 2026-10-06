import { z } from "zod";

const text = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !value.includes("\0"));
const categories = z
  .array(
    z.enum([
      "credentials.api-keys",
      "preferences.agent-provider",
      "preferences.desktop-appearance",
      "preferences.chat-voice",
      "memory.global",
      "customizations.prompts-global",
      "context-packs.global",
      "mcp.global",
      "ralph.preferences-global",
      "ralph.flows-global",
    ]),
  )
  .min(1)
  .max(10)
  .refine((values) => new Set(values).size === values.length);
const start = z.strictObject({
  categories,
  displayName: text(240),
  interfaceIds: z.array(text(240).min(1)).max(64),
});
const operationId = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);
const passphrase = text(1024).refine(
  (value) => new TextEncoder().encode(value).length <= 1024,
);
const noArgs = z.strictObject({});

export const deviceSettingsTransferCommands = {
  get_settings_transfer_status: noArgs,
  get_settings_transfer_catalog: noArgs,
  start_settings_transfer: z.strictObject({ request: start }),
  start_settings_receive: z.strictObject({ request: start }),
  connect_settings_transfer: z.strictObject({
    request: z
      .strictObject({
        discoveredId: text(240).min(1).nullable(),
        manualCode: text(2200).min(1).nullable(),
      })
      .refine(
        (value) =>
          (value.discoveredId === null) !== (value.manualCode === null),
      ),
  }),
  confirm_settings_transfer_pairing: noArgs,
  approve_settings_transfer: noArgs,
  stop_settings_transfer: noArgs,
  export_encrypted_settings_file: z.strictObject({
    request: z.strictObject({
      categories,
      destinationPath: text(4096).min(1),
      passphrase,
    }),
  }),
  inspect_encrypted_settings_file: z.strictObject({
    request: z.strictObject({
      operationId,
      categories,
      sourcePath: text(4096).min(1),
      passphrase,
    }),
  }),
  commit_encrypted_settings_file_import: z.strictObject({
    request: z.strictObject({ token: operationId }),
  }),
  cancel_encrypted_settings_file_import: z.strictObject({
    request: z.strictObject({ operationId }),
  }),
} as const;
