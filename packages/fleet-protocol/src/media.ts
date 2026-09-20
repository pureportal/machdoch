import { z } from "zod";

export const mediaCommands = [
  "media_read_studio_state",
  "media_write_studio_state",
  "media_create_transfer",
  "media_write_transfer",
  "media_read_transfer",
  "media_remove_transfer",
  "media_analyze_image_quality",
  "media_auto_tag_asset",
  "media_cancel_civitai_download",
  "media_cancel_model_install",
  "media_cancel_run",
  "media_civitai_connection",
  "media_civitai_options",
  "media_connect_civitai",
  "media_delete_asset",
  "media_discover_workspace_models",
  "media_download_civitai_resource",
  "media_execute_local_image_flow",
  "media_execute_remote_image_edit_flow",
  "media_execute_workflow",
  "media_export_asset",
  "media_export_flow_revision",
  "media_generate_images",
  "media_generate_svg",
  "media_generate_video",
  "media_get_civitai_model",
  "media_get_flow",
  "media_get_model_catalog",
  "media_get_model_install_job",
  "media_get_run_detail",
  "media_get_runtime_setup",
  "media_import_flow",
  "media_import_image",
  "media_import_image_url",
  "media_import_local_model",
  "media_import_model_addon",
  "media_initialize_runtime",
  "media_inspect_civitai_file",
  "media_inspect_civitai_model_addon",
  "media_inspect_flow_import",
  "media_inspect_hardware",
  "media_inspect_local_model",
  "media_inspect_model_addon",
  "media_install_workflow_model",
  "media_list_asset_page",
  "media_list_assets",
  "media_list_flows",
  "media_list_run_page",
  "media_list_runs",
  "media_plan_asset_deletion",
  "media_plan_model_addon_removal",
  "media_plan_model_install",
  "media_plan_model_removal",
  "media_probe_local_model",
  "media_read_asset_preview",
  "media_read_quality_report",
  "media_refresh_local_diffusers_runtime",
  "media_remove_model",
  "media_remove_model_addon",
  "media_resolve_human_review",
  "media_resolve_provider_review",
  "media_save_flow_revision",
  "media_search_civitai",
  "media_set_asset_tags",
  "media_start_model_install",
  "media_start_runtime_setup",
  "media_transform_image",
  "media_update_model_resource",
  "media_wake_provider_reconciliation",
] as const;

export const mediaRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("release"), id: z.string().uuid() }),
  z.strictObject({
    kind: z.literal("invoke"),
    id: z.string().uuid(),
    command: z.enum(mediaCommands),
    args: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    kind: z.literal("read"),
    id: z.string().uuid(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 * 1024),
  }),
  z.strictObject({
    kind: z.literal("events"),
    after: z.number().int().nonnegative(),
  }),
]);
export const mediaResponseSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("complete"),
    chunk: z.string().max(262144),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.strictObject({ state: z.literal("failed"), error: z.json() }),
  z.strictObject({
    state: z.literal("events"),
    cursor: z.number().int().nonnegative(),
    events: z
      .array(
        z.strictObject({
          name: z.enum([
            "media-import-progress",
            "media-civitai-download-progress",
          ]),
          payload: z.json(),
        }),
      )
      .max(256),
  }),
]);
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export type MediaResponse = z.infer<typeof mediaResponseSchema>;
