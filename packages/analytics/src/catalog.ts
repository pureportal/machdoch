export const ANALYTICS_ENDPOINT = "https://swetrix.pureportal.io/backend/log";
export const PRIVACY_URL = "https://pureportal.io/privacy";
export const NOTICE_REVISION = "machdoch-analytics-2026-10-10";
export const PROJECTS = {
  landing: "kUVZeJbmLZnJ",
  fleet: "CPs0D0S7QOfV",
  software: "6UblQ7EkvVkW",
} as const;
export type AnalyticsApp = keyof typeof PROJECTS;

export const FEATURES = [
  "landing.overview",
  "landing.features",
  "landing.download",
  "landing.github",
  "chat",
  "voice",
  "ralph",
  "scheduler",
  "workspaces",
  "terminal",
  "git",
  "files",
  "instructions",
  "mcp",
  "media.generate",
  "media.library",
  "media.workflows",
  "media.training",
  "media.models",
  "settings",
  "update",
  "command-palette",
  "fleet.instances",
  "fleet.workspaces",
  "fleet.enrollment",
  "fleet.users",
  "fleet.settings",
  "fleet.copilot",
] as const;
export type Feature = (typeof FEATURES)[number];

export const OPERATIONS = {
  run_desktop_task: "chat",
  cancel_desktop_task: "chat",
  run_task_interview_command: "chat",
  synthesize_user_voice_audio: "voice",
  begin_user_speech_transcription: "voice",
  transcribe_user_speech: "voice",
  run_ralph_command: "ralph",
  run_scheduler_command: "scheduler",
  run_instruction_command: "instructions",
  run_mcp_command: "mcp",
  run_provider_sync_command: "mcp",
  start_workspace_terminal: "terminal",
  stop_workspace_terminal: "terminal",
  open_workspace_terminal_host: "terminal",
  save_workspace_file: "files",
  read_workspace_file: "files",
  create_workspace_entry: "files",
  delete_workspace_entry: "files",
  rename_workspace_entry: "files",
  run_workspace_git_action: "git",
  start_workspace_run_configuration: "workspaces",
  stop_workspace_run_configuration: "workspaces",
  restart_workspace_run_configuration: "workspaces",
  save_workspace_run_configuration_document: "workspaces",
  media_generate_images: "media.generate",
  media_generate_svg: "media.generate",
  media_generate_video: "media.generate",
  media_generate_audio: "media.generate",
  media_execute_local_image_flow: "media.workflows",
  media_execute_remote_image_edit_flow: "media.workflows",
  media_save_flow_revision: "media.workflows",
  media_import_flow: "media.workflows",
  media_export_flow_revision: "media.workflows",
  media_transform_image: "media.generate",
  media_analyze_image_quality: "media.generate",
  media_cancel_run: "media.generate",
  media_resolve_human_review: "media.workflows",
  media_resolve_provider_review: "media.workflows",
  media_submit_training: "media.training",
  media_resume_training: "media.training",
  media_finish_training: "media.training",
  media_cancel_training: "media.training",
  media_start_model_install: "media.models",
  media_remove_model: "media.models",
  media_cancel_model_install: "media.models",
  media_import_local_model: "media.models",
  media_import_model_addon: "media.models",
  media_remove_model_addon: "media.models",
  media_update_model_resource: "media.models",
  media_import_asset: "media.library",
  media_import_image_url: "media.library",
  media_export_asset: "media.library",
  media_delete_asset: "media.library",
  media_set_asset_tags: "media.library",
  media_auto_tag_asset: "media.library",
  save_user_desktop_settings: "settings",
  enroll_fleet_manager: "fleet.enrollment",
  reset_fleet_manager_connection: "fleet.enrollment",
  "update.check": "update",
  "update.download": "update",
  "update.install": "update",
  "cli.run": "chat",
  "cli.chat": "chat",
  "cli.interview": "chat",
  "cli.ralph": "ralph",
  "cli.scheduler": "scheduler",
  "cli.fleet": "fleet.instances",
  "cli.instructions": "instructions",
  "cli.mcp": "mcp",
  "cli.config": "settings",
  "cli.update": "update",
  "fleet.login": "fleet.instances",
  "fleet.logout": "fleet.instances",
  "fleet.enrollment.create": "fleet.enrollment",
  "fleet.users.create": "fleet.users",
  "fleet.users.update": "fleet.users",
  "fleet.users.delete": "fleet.users",
  "fleet.settings.save": "fleet.settings",
  "fleet.instances.control": "fleet.instances",
  "fleet.copilot.send": "fleet.copilot",
} as const satisfies Record<string, Feature>;
export type Operation = keyof typeof OPERATIONS;

export function commandFeature(id: string): Feature | undefined {
  if (id === "app.palette.toggle") return "command-palette";
  const normalized = id.replace(/^page:/, "");
  if (normalized.startsWith("app.view."))
    return navigationFeature(normalized.slice(9));
  if (normalized === "app.settings.open") return "settings";
  if (normalized === "app.scheduler.open") return "scheduler";
  if (normalized === "app.fleet-manager.open") return "fleet.instances";
  if (/^media\.(flow|layout|selection)\./.test(normalized))
    return "media.workflows";
  if (normalized.startsWith("media.activity.")) return "media.library";
  const workspaceTool =
    /^workspaces\.(file|files|git|terminal|instructions)\./.exec(
      normalized,
    )?.[1];
  if (workspaceTool)
    return workspaceTool === "file" || workspaceTool === "files"
      ? "files"
      : (workspaceTool as Feature);
  const scope = normalized.split(".")[0];
  const known: Readonly<Record<string, Feature>> = {
    chat: "chat",
    composer: "chat",
    session: "chat",
    voice: "voice",
    ralph: "ralph",
    scheduler: "scheduler",
    workspace: "workspaces",
    workspaces: "workspaces",
    terminal: "terminal",
    git: "git",
    file: "files",
    instructions: "instructions",
    media: "media.generate",
    training: "media.training",
    model: "media.models",
    settings: "settings",
    mcp: "mcp",
  };
  return scope && Object.hasOwn(known, scope) ? known[scope] : undefined;
}

export function navigationFeature(id: string): Feature | undefined {
  const fleetFeatures: Readonly<Record<string, Feature>> = {
    "/instances": "fleet.instances",
    "/workspaces": "fleet.workspaces",
    "/enrollment": "fleet.enrollment",
    "/users": "fleet.users",
    "/settings": "fleet.settings",
    "/copilot": "fleet.copilot",
  };
  if (Object.hasOwn(fleetFeatures, id)) return fleetFeatures[id];
  return Object.hasOwn(VIEW_FEATURES, id) ? VIEW_FEATURES[id] : undefined;
}

export function isFeature(value: string): value is Feature {
  return FEATURES.includes(value as Feature);
}

export function operationFeature(value: string): Feature | undefined {
  return Object.hasOwn(OPERATIONS, value)
    ? OPERATIONS[value as Operation]
    : undefined;
}

export function invocationOperation(command: string, args?: unknown): string {
  if (
    ![
      "run_ralph_command",
      "run_scheduler_command",
      "run_instruction_command",
      "run_mcp_command",
      "run_provider_sync_command",
    ].includes(command)
  )
    return command;
  const request = (args as { request?: { arguments?: unknown } } | undefined)
    ?.request;
  if (!Array.isArray(request?.arguments)) return "";
  const action = request.arguments[0];
  return [
    "run",
    "resume",
    "create",
    "save",
    "delete",
    "remove",
    "update",
    "enable",
    "disable",
    "pause",
    "cancel",
    "retry",
    "interview",
    "import",
    "export",
    "add",
    "connect",
    "disconnect",
    "sync",
    "set",
    "enqueue",
    "run-now",
  ].includes(action)
    ? command
    : "";
}

export function routeFor(app: AnalyticsApp, pathname: string): string {
  if (app === "landing") return "/";
  if (app === "software") return "/app";
  if (/^\/instances\/[^/]+\/runs\/?$/.test(pathname))
    return "/instances/:instance/runs";
  if (/^\/instances\/[^/]+\/?$/.test(pathname)) return "/instances/:instance";
  const embeddedView =
    /^\/media-studio\/(index|ralph|scheduler|instructions|settings|workspaces)\.html$/.exec(
      pathname,
    )?.[1];
  if (embeddedView)
    return embeddedView === "index" ? "/media-studio" : `/app/${embeddedView}`;
  return [
    "/",
    "/login",
    "/instances",
    "/workspaces",
    "/enrollment",
    "/users",
    "/settings",
    "/copilot",
    "/privacy",
  ].includes(pathname)
    ? pathname
    : "/other";
}

export function fleetOperation(
  path: string,
  method: string,
): Operation | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (path === "/api/auth/login") return "fleet.login";
  if (path === "/api/auth/logout") return "fleet.logout";
  if (/^\/api\/enrollment-keys(?:\/[^/]+)?$/.test(path))
    return "fleet.enrollment.create";
  if (/^\/api\/users(?:\/[^/]+)?$/.test(path)) {
    return method === "DELETE"
      ? "fleet.users.delete"
      : method === "POST"
        ? "fleet.users.create"
        : "fleet.users.update";
  }
  if (/^\/api\/settings\//.test(path)) return "fleet.settings.save";
  if (/^\/api\/instances\/[^/]+(?:\/commands)?$/.test(path))
    return "fleet.instances.control";
  if (/^\/api\/copilot\//.test(path) || path === "/api/fleet/sessions")
    return "fleet.copilot.send";
  return undefined;
}

export const VIEW_FEATURES: Readonly<Record<string, Feature>> = {
  chat: "chat",
  voice: "voice",
  ralph: "ralph",
  scheduler: "scheduler",
  workspaces: "workspaces",
  instructions: "instructions",
  media: "media.generate",
  library: "media.library",
  generate: "media.generate",
  workflows: "media.workflows",
  training: "media.training",
  models: "media.models",
  settings: "settings",
  train: "media.training",
  flow: "media.workflows",
  runs: "media.library",
};
