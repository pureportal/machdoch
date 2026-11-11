import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  getAuthType,
  getServerId,
  getServerKey,
  getServerStatus,
  getString,
  getTransportType,
  type McpServerStatus,
} from "./mcp-config-model";
import type { McpServerEditor } from "./use-mcp-server-editor";

const STATUS_DOT_CLASS: Record<McpServerStatus, string> = {
  enabled: "bg-emerald-400",
  disabled: "bg-slate-600",
  "needs-setup": "bg-rose-400",
};

const STATUS_LABEL: Record<McpServerStatus, string | null> = {
  enabled: null,
  disabled: "Disabled",
  "needs-setup": "Needs setup",
};

export const McpServerList = ({
  editor,
  selectionVisible = true,
  onSelectServer,
}: {
  editor: McpServerEditor;
  selectionVisible?: boolean;
  onSelectServer: (serverId: string) => void;
}): JSX.Element | null => {
  const { parsed, validationIssues } = editor;

  if (parsed.servers.length === 0) {
    return null;
  }

  return (
    <ul aria-label="MCP servers" className="grid content-start gap-1">
      {parsed.servers.map((server, index) => {
        const serverId = getServerId(server, index);
        const serverKey = getServerKey(server, index);
        const selected = selectionVisible && index === editor.selectedIndex;
        const status = getServerStatus(
          server,
          validationIssues.filter((issue) => issue.serverKey === serverKey),
        );
        const statusLabel = STATUS_LABEL[status];
        const authType = getAuthType(server);

        return (
          <li key={serverKey}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectServer(serverId)}
              className={cn(
                "w-full rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/60",
                selected
                  ? "border-sky-500/30 bg-sky-500/10"
                  : "border-transparent hover:border-slate-800 hover:bg-slate-900",
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    STATUS_DOT_CLASS[status],
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm font-medium",
                    status === "disabled" ? "text-slate-400" : "text-slate-100",
                  )}
                >
                  {getString(server, "title") || serverId}
                </span>
                {statusLabel ? (
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-medium",
                      status === "needs-setup"
                        ? "text-rose-300"
                        : "text-slate-500",
                    )}
                  >
                    {statusLabel}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4.5 text-[11px] text-slate-500">
                <span className="min-w-0 truncate font-mono">{serverId}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  {getTransportType(server)}
                  {authType === "none" ? "" : ` · ${authType}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};
