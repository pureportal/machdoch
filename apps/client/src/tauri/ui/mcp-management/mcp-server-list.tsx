import { useState, type JSX } from "react";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { SettingsToggle } from "../chat-session/components/settings-dialog-panels/settings-toggle";
import {
  filterServerIndexes,
  getAuthType,
  getBoolean,
  getServerId,
  getServerKey,
  getServerStatus,
  getString,
  getTransportType,
  type McpServerStatus,
} from "./mcp-config-model";
import type { McpServerEditor } from "./use-mcp-server-editor";

const SEARCH_THRESHOLD = 5;

const STATUS_DOT_CLASS: Record<McpServerStatus, string> = {
  enabled: "bg-emerald-400",
  disabled: "bg-slate-600",
  "needs-setup": "bg-rose-400",
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
  const [query, setQuery] = useState("");
  const searchable = parsed.servers.length >= SEARCH_THRESHOLD;
  const visibleIndexes = filterServerIndexes(
    parsed.servers,
    searchable ? query : "",
  );

  if (parsed.servers.length === 0) {
    return null;
  }

  return (
    <div className="grid min-w-0 content-start gap-2">
      {searchable ? (
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter MCP servers"
          placeholder="Filter servers"
          className="h-8 rounded-lg border-slate-800 bg-slate-950 text-sm"
        />
      ) : null}
      {visibleIndexes.length === 0 ? (
        <p role="status" className="px-3 py-2 text-sm text-slate-500">
          No matching servers.
        </p>
      ) : null}
      <ul aria-label="MCP servers" className="grid content-start gap-0.5">
        {visibleIndexes.map((index) => {
          const server = parsed.servers[index]!;
          const serverId = getServerId(server, index);
          const serverKey = getServerKey(server, index);
          const selected = selectionVisible && index === editor.selectedIndex;
          const status = getServerStatus(
            server,
            validationIssues.filter((issue) => issue.serverKey === serverKey),
          );
          const authType = getAuthType(server);
          const title = getString(server, "title") || serverId;

          return (
            <li
              key={serverKey}
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-lg border pr-1.5 transition-colors",
                selected
                  ? "border-sky-500/30 bg-sky-500/10"
                  : "border-transparent hover:border-slate-800 hover:bg-slate-900",
              )}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectServer(serverId)}
                className="min-w-0 flex-1 rounded-lg py-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
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
                      status === "disabled"
                        ? "text-slate-400"
                        : "text-slate-100",
                    )}
                  >
                    {title}
                  </span>
                  {status === "needs-setup" ? (
                    <span className="shrink-0 text-[11px] font-medium text-rose-300">
                      Needs setup
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-4.5 text-[11px] text-slate-500">
                  {title !== serverId ? (
                    <>
                      <span className="min-w-0 truncate font-mono">
                        {serverId}
                      </span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span className="shrink-0">
                    {getTransportType(server)}
                    {authType === "none" ? "" : ` · ${authType}`}
                  </span>
                </span>
              </button>
              <SettingsToggle
                size="sm"
                label={`Enable ${title}`}
                checked={getBoolean(server, "enabled", true)}
                disabled={editor.disabled}
                onCheckedChange={(checked) =>
                  editor.setServerEnabled(index, checked)
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
};
