import {
  mcpAppProtocolVersion,
  type McpAppRequest,
  type McpAppView,
} from "@machdoch/fleet-protocol/mcp-apps";
import { sandboxedAppHtml } from "./sandbox";

export type McpAppInvoke = <T>(
  workspaceRoot: string,
  input: McpAppRequest,
) => Promise<T>;
type Message = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

export function connectMcpApp({
  view,
  workspaceRoot,
  invoke,
  send,
  confirmTool,
  onHeight,
  onInitialized,
}: {
  view: McpAppView;
  workspaceRoot: string;
  invoke: McpAppInvoke;
  send: (message: Message) => void;
  confirmTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  onHeight: (height: number) => void;
  onInitialized?: () => void;
}) {
  let initialized = false;
  let negotiated = false;
  let closed = false;
  let pending = false;
  const handled = new Set<string | number>();
  const notify = (method: string, params: Record<string, unknown>): void =>
    send({ jsonrpc: "2.0", method, params });
  return {
    async receive(value: unknown): Promise<void> {
      if (closed || !value || typeof value !== "object") return;
      try {
        if (JSON.stringify(value).length > 256_000) return;
      } catch {
        return;
      }
      const message = value as Message;
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
        return;
      const id = message.id;
      if (id !== undefined && typeof id !== "string" && typeof id !== "number")
        return;
      if (typeof id === "number" && !Number.isSafeInteger(id)) return;
      if (typeof id === "string" && id.length > 200) return;
      if (id !== undefined) {
        if (handled.has(id)) return;
        handled.add(id);
        if (handled.size > 2000) {
          closed = true;
          return;
        }
      }
      const respond = (result: unknown): void => {
        if (!closed && id !== undefined) send({ jsonrpc: "2.0", id, result });
      };
      const reject = (text: string, code = -32602): void => {
        if (!closed && id !== undefined)
          send({ jsonrpc: "2.0", id, error: { code, message: text } });
      };
      const params = message.params ?? {};
      if (message.method === "ui/notifications/sandbox-proxy-ready") {
        notify("ui/notifications/sandbox-resource-ready", {
          html: sandboxedAppHtml(view),
          sandbox: "allow-scripts allow-same-origin",
          csp: view.csp,
          permissions: {},
        });
        return;
      }
      if (message.method === "ui/initialize") {
        if (negotiated || params.protocolVersion !== mcpAppProtocolVersion) {
          reject("Unsupported or repeated app initialization.");
          return;
        }
        negotiated = true;
        respond({
          protocolVersion: mcpAppProtocolVersion,
          hostInfo: { name: "Machdoch", version: "1.0.0" },
          hostCapabilities: {
            serverTools: {},
            sandbox: { csp: view.csp, permissions: {} },
          },
          hostContext: {
            displayMode: "inline",
            availableDisplayModes: ["inline"],
            theme: document.documentElement.classList.contains("dark")
              ? "dark"
              : "light",
            locale: navigator.language,
            platform: "web",
            containerDimensions: { maxHeight: 800 },
          },
        });
        return;
      }
      if (
        message.method === "ui/notifications/initialized" &&
        negotiated &&
        !initialized
      ) {
        initialized = true;
        notify("ui/notifications/tool-input", { arguments: view.arguments });
        notify("ui/notifications/tool-result", view.result);
        onInitialized?.();
        return;
      }
      if (!initialized) {
        reject("Initialize the app before making requests.");
        return;
      }
      if (message.method === "ping") {
        respond({});
        return;
      }
      if (message.method === "ui/notifications/size-changed") {
        if (typeof params.height === "number" && Number.isFinite(params.height))
          onHeight(Math.min(800, Math.max(180, params.height)));
        return;
      }
      if (message.method !== "tools/call") {
        reject("This app capability is unavailable.", -32601);
        return;
      }
      if (
        id === undefined ||
        pending ||
        typeof params.name !== "string" ||
        !params.name ||
        (params.arguments !== undefined &&
          (!params.arguments ||
            typeof params.arguments !== "object" ||
            Array.isArray(params.arguments)))
      ) {
        reject("Wait for the current action or provide valid tool arguments.");
        return;
      }
      pending = true;
      try {
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!(await confirmTool(params.name, args))) {
          reject("The action was cancelled.");
          return;
        }
        if (closed) return;
        const result = await invoke(workspaceRoot, {
          action: "call-tool",
          id: view.id,
          name: params.name,
          arguments: args,
          confirmed: true,
        });
        respond(result);
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error), -32603);
      } finally {
        pending = false;
      }
    },
    close(): void {
      if (!closed && initialized)
        send({
          jsonrpc: "2.0",
          id: `teardown-${view.id}`,
          method: "ui/resource-teardown",
          params: {},
        });
      closed = true;
    },
  };
}
