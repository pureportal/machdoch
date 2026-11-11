import { McpAppsSettings } from "@machdoch/client-ui/mcp-apps/settings";
import { ArrowLeftRight, ChevronDown, Server } from "lucide-react";
import { useState, type JSX } from "react";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { SubmitShortcut } from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { invokeWorkspaceTools } from "../../../workspace-management/workspace-platform";
import { McpDraftActions } from "../../../mcp-management/mcp-draft-actions";
import { McpServerDetail } from "../../../mcp-management/mcp-server-detail";
import { McpServerList } from "../../../mcp-management/mcp-server-list";
import {
  useMcpServerEditor,
  type McpServerEditor,
} from "../../../mcp-management/use-mcp-server-editor";
import { useSettingsNavigationGuard } from "./navigation-guard";
import { ProviderSyncControl } from "./provider-sync-control";
import { SettingsCard, SettingsStatus } from "./shared";
import type { McpSettingsControls } from "./types";

export interface McpSettingsPanelProps {
  setup: McpSettingsControls;
  showProviderSync?: boolean;
  layout?: "card" | "page";
}

type PageView = "servers" | "provider-sync";

const ConfigError = ({ error }: { error: string }): JSX.Element => (
  <p
    role="alert"
    className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
  >
    {error}
  </p>
);

const McpPageLayout = ({
  editor,
  showProviderSync,
}: {
  editor: McpServerEditor;
  showProviderSync: boolean;
}): JSX.Element => {
  const [view, setView] = useState<PageView>("servers");
  const { setup, parsed, selectedServer } = editor;
  const providerSyncVisible = showProviderSync && view === "provider-sync";

  return (
    <SubmitShortcut asChild>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-900 px-6 py-4">
          <div className="grid min-w-0 gap-0.5">
            <h1 className="text-lg font-semibold text-slate-100">
              MCP servers
            </h1>
            <p className="truncate font-mono text-xs text-slate-500">
              {setup.document.path}
            </p>
          </div>
          <McpDraftActions editor={editor} />
        </header>

        {setup.message ? (
          <div className="shrink-0 border-b border-slate-900 px-6 py-3">
            <SettingsStatus message={setup.message} />
          </div>
        ) : null}

        <div className="app-management-panes grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(11rem,30vh)_minmax(0,1fr)] lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-900 bg-slate-950/70">
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {parsed.error ? null : (
                <McpServerList
                  editor={editor}
                  selectionVisible={!providerSyncVisible}
                  onSelectServer={(serverId) => {
                    setView("servers");
                    editor.selectServer(serverId);
                  }}
                />
              )}
            </div>
            <div className="grid shrink-0 gap-1 border-t border-slate-900 p-2">
              {showProviderSync ? (
                <button
                  type="button"
                  aria-pressed={providerSyncVisible}
                  onClick={() => setView("provider-sync")}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-lg border px-3 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/60",
                    providerSyncVisible
                      ? "border-sky-500/30 bg-sky-500/10 text-slate-100"
                      : "border-transparent text-slate-300 hover:border-slate-800 hover:bg-slate-900",
                  )}
                >
                  <ArrowLeftRight
                    aria-hidden="true"
                    className="size-4 text-slate-500"
                  />
                  Provider sync
                </button>
              ) : null}
              <div className="px-3 py-2">
                <McpAppsSettings
                  invoke={(workspaceRoot, input) =>
                    invokeWorkspaceTools("run_mcp_app_command", {
                      workspaceRoot,
                      input,
                    })
                  }
                />
              </div>
            </div>
          </aside>

          <section className="min-h-0 min-w-0 overflow-y-auto">
            <div className="mx-auto grid w-full max-w-4xl min-w-0 gap-5 px-6 py-6">
              {parsed.error ? (
                <ConfigError error={parsed.error} />
              ) : providerSyncVisible ? (
                <div className="grid gap-4">
                  <h2 className="text-lg font-semibold tracking-tight text-slate-100">
                    Provider sync
                  </h2>
                  <ProviderSyncControl
                    workspaceRoot={setup.workspaceRoot}
                    showDiagnostics
                  />
                </div>
              ) : selectedServer ? (
                <McpServerDetail editor={editor} server={selectedServer} />
              ) : (
                <EmptyState icon={Server} title="No MCP servers" size="large" />
              )}
            </div>
          </section>
        </div>
      </div>
    </SubmitShortcut>
  );
};

const McpCardLayout = ({
  editor,
  showProviderSync,
}: {
  editor: McpServerEditor;
  showProviderSync: boolean;
}): JSX.Element => {
  const { setup, parsed, selectedServer } = editor;

  return (
    <SettingsCard title="MCP servers">
      <SubmitShortcut asChild>
        <div className="grid gap-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-slate-500">
              {setup.document.path}
            </p>
            <McpDraftActions editor={editor} />
          </div>

          {parsed.error ? (
            <ConfigError error={parsed.error} />
          ) : (
            <div
              className={cn(
                "grid min-w-0 items-start gap-5",
                selectedServer &&
                  "@min-[50rem]/settings-card:grid-cols-[15rem_minmax(0,1fr)]",
              )}
            >
              {parsed.servers.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title="No MCP servers"
                  size="compact"
                />
              ) : (
                <McpServerList
                  editor={editor}
                  onSelectServer={editor.selectServer}
                />
              )}
              {selectedServer ? (
                <McpServerDetail
                  editor={editor}
                  server={selectedServer}
                  className="@min-[50rem]/settings-card:border-l @min-[50rem]/settings-card:border-slate-800/70 @min-[50rem]/settings-card:pl-5"
                />
              ) : null}
            </div>
          )}

          {showProviderSync ? (
            <details className="group rounded-lg border border-slate-800">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-3 text-sm font-medium text-slate-200 outline-none hover:bg-slate-900 focus-visible:ring-2 focus-visible:ring-sky-400 [&::-webkit-details-marker]:hidden">
                Provider sync
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 text-slate-400 transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="px-3 pb-3">
                <ProviderSyncControl
                  workspaceRoot={setup.workspaceRoot}
                  showDiagnostics
                />
              </div>
            </details>
          ) : null}

          <SettingsStatus message={setup.message} />
        </div>
      </SubmitShortcut>
    </SettingsCard>
  );
};

export const McpSettingsPanel = ({
  setup,
  showProviderSync = false,
  layout = "card",
}: McpSettingsPanelProps): JSX.Element => {
  const editor = useMcpServerEditor(setup);

  useSettingsNavigationGuard({
    dirty: editor.dirty || setup.saving,
    title: setup.saving
      ? "Saving MCP server changes"
      : "Discard MCP server changes?",
    description: setup.saving
      ? "Wait for the MCP configuration save to finish before leaving."
      : "The MCP configuration contains changes that have not been saved.",
    canDiscard: !setup.saving,
    onDiscard: editor.discardChanges,
  });

  return layout === "page" ? (
    <McpPageLayout editor={editor} showProviderSync={showProviderSync} />
  ) : (
    <McpCardLayout editor={editor} showProviderSync={showProviderSync} />
  );
};
