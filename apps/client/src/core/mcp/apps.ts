import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  mcpAppCspSchema,
  mcpAppMimeType,
  mcpAppRequestSchema,
  mcpAppToolUiSchema,
  type McpAppView,
} from "@machdoch/fleet-protocol/mcp-apps";
import { openWorkspaceLibrary } from "../workspace-library/database.js";
import { canonicalDigest } from "../instruction-system/normalization.js";
import { mcpAppsEnabled, setMcpAppsEnabled } from "./app-settings.js";
import { mcpClientManager } from "./client.js";
import { getEnabledMcpServer, loadMcpConfig } from "./config.js";
import type { McpEffectiveServerConfig } from "./types.js";

const recordSchema = z.strictObject({
  id: z.string().uuid(),
  serverId: z.string(),
  serverIdentity: z.string(),
  toolName: z.string(),
  uri: z.string().startsWith("ui://"),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
});
const serverIdentity = (server: McpEffectiveServerConfig): string =>
  canonicalDigest({ transport: server.transport, auth: server.auth });

async function openAppDatabase(root: string) {
  const database = await openWorkspaceLibrary(root);
  database.exec(
    "CREATE TABLE IF NOT EXISTS mcp_apps (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS mcp_app_runs (run_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES mcp_apps(id), PRIMARY KEY(run_id, app_id))",
  );
  return database;
}

export async function captureMcpApp(
  root: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  readOnly: boolean,
  runId?: string,
): Promise<string | undefined> {
  if (!mcpAppsEnabled() || result.isError) return undefined;
  const meta = result._meta as Record<string, unknown> | undefined;
  const parsed = mcpAppToolUiSchema.safeParse(meta?.["machdoch/toolUi"]);
  if (!parsed.success || !parsed.data.resourceUri) return undefined;
  const server = getEnabledMcpServer(await loadMcpConfig(root), serverId);
  if (!server) throw new Error("The MCP server is disabled.");
  const id = randomUUID();
  const { _meta, ...publicResult } = result;
  const resultMeta =
    _meta && typeof _meta === "object"
      ? ({ ..._meta } as Record<string, unknown>)
      : {};
  delete resultMeta["machdoch/toolUi"];
  const document = JSON.stringify(
    recordSchema.parse({
      id,
      serverId,
      serverIdentity: serverIdentity(server),
      toolName,
      uri: parsed.data.resourceUri,
      arguments: args,
      result: { ...publicResult, _meta: resultMeta },
      readOnly,
    }),
  );
  if (Buffer.byteLength(document) > 2 * 1024 * 1024)
    throw new Error("The interactive result exceeds 2 MiB.");
  const database = await openAppDatabase(root);
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("INSERT INTO mcp_apps (id, document) VALUES (?, ?)")
      .run(id, document);
    if (runId)
      database
        .prepare("INSERT INTO mcp_app_runs (run_id, app_id) VALUES (?, ?)")
        .run(runId, id);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  return id;
}

export async function listMcpAppsForRun(
  root: string,
  runId: string,
): Promise<string[]> {
  if (!mcpAppsEnabled()) return [];
  const database = await openAppDatabase(root);
  try {
    return database
      .prepare(
        "SELECT app_id FROM mcp_app_runs WHERE run_id = ? ORDER BY rowid LIMIT 100",
      )
      .all(runId)
      .map((row) => String(row.app_id));
  } finally {
    database.close();
  }
}

export async function runMcpAppRequest(
  root: string,
  input: unknown,
): Promise<unknown> {
  const request = mcpAppRequestSchema.parse(input);
  if (request.action === "settings") return { enabled: mcpAppsEnabled() };
  if (request.action === "set-enabled")
    return setMcpAppsEnabled(request.enabled);
  if (!mcpAppsEnabled())
    throw new Error(
      "MCP Apps is disabled. Enable it in settings to open this result.",
    );
  const database = await openAppDatabase(root);
  let stored: unknown;
  try {
    stored = database
      .prepare("SELECT document FROM mcp_apps WHERE id = ?")
      .get(request.id)?.document;
  } finally {
    database.close();
  }
  if (typeof stored !== "string")
    throw new Error(
      "This interactive result is unavailable. Run the tool again.",
    );
  const app = recordSchema.parse(JSON.parse(stored));
  const server = getEnabledMcpServer(await loadMcpConfig(root), app.serverId);
  if (!server || serverIdentity(server) !== app.serverIdentity)
    throw new Error(
      "The MCP server configuration changed. Run the tool again.",
    );
  const discovery = await mcpClientManager.discoverServer(root, server);
  const originalTool = discovery.tools.find(
    (tool) => tool.name === app.toolName,
  );
  if (server.toolOverrides?.[app.toolName]?.enabled === false)
    throw new Error("This tool is disabled.");
  const ui = mcpAppToolUiSchema.safeParse(originalTool?._meta?.ui);
  if (!ui.success || ui.data.resourceUri !== app.uri)
    throw new Error(
      "This tool no longer exposes the saved app. Run the tool again.",
    );
  if (request.action === "call-tool") {
    if (JSON.stringify(request.arguments).length > 128_000)
      throw new Error("The app tool request is too large.");
    const tool = discovery.tools.find(
      (candidate) => candidate.name === request.name,
    );
    const visibility = mcpAppToolUiSchema.safeParse(tool?._meta?.ui);
    if (tool?._meta?.ui !== undefined && !visibility.success)
      throw new Error("This tool has invalid app metadata.");
    if (
      !tool ||
      (visibility.success &&
        visibility.data.visibility &&
        !visibility.data.visibility.includes("app"))
    )
      throw new Error("This tool is not available to apps.");
    const override = server.toolOverrides?.[tool.name];
    if (override?.enabled === false) throw new Error("This tool is disabled.");
    if (
      app.readOnly &&
      !(override?.effect
        ? override.effect === "external-read"
        : tool.annotations?.readOnlyHint === true)
    )
      throw new Error("This conversation only permits read-only app tools.");
    return mcpClientManager.callTool(
      root,
      app.serverId,
      request.name,
      request.arguments,
      { authoritativeDiscovery: discovery, caller: "app" },
    );
  }
  const resource = await mcpClientManager.readResource(
    root,
    app.serverId,
    app.uri,
  );
  const content = resource.contents.find(
    (entry) => entry.uri === app.uri && entry.mimeType === mcpAppMimeType,
  );
  if (!content) throw new Error("The MCP App must provide an HTML resource.");
  const html =
    "text" in content && typeof content.text === "string"
      ? content.text
      : "blob" in content && typeof content.blob === "string"
        ? new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(content.blob, "base64"),
          )
        : undefined;
  if (html === undefined || Buffer.byteLength(html) > 2 * 1024 * 1024)
    throw new Error("The MCP App must provide HTML smaller than 2 MiB.");
  const resourceUi = content._meta?.ui as Record<string, unknown> | undefined;
  const view: McpAppView = {
    id: app.id,
    title: originalTool?.title ?? app.toolName,
    html,
    csp: mcpAppCspSchema.parse(resourceUi?.csp ?? {}),
    arguments: app.arguments,
    result: app.result,
  };
  return view;
}
