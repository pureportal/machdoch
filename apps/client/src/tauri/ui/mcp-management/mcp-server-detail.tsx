import { Copy, LoaderCircle, MoreHorizontal, Plug, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { SettingsToggle } from "../chat-session/components/settings-dialog-panels/settings-toggle";
import {
  describeServerConnection,
  getBoolean,
  getString,
  type ServerRecord,
} from "./mcp-config-model";
import {
  McpAuthSection,
  McpSetupSection,
} from "./mcp-server-connection-sections";
import {
  McpAdvancedSection,
  McpCapabilitiesSection,
} from "./mcp-server-runtime-sections";
import { MCP_SECONDARY_BUTTON_CLASS } from "./mcp-form-fields";
import type { McpServerEditor, McpServerTab } from "./use-mcp-server-editor";

const SERVER_TABS: ReadonlyArray<{ value: McpServerTab; label: string }> = [
  { value: "setup", label: "Setup" },
  { value: "auth", label: "Auth" },
  { value: "capabilities", label: "Capabilities" },
  { value: "advanced", label: "Advanced" },
];

const renderTab = (
  editor: McpServerEditor,
  server: ServerRecord,
): JSX.Element => {
  switch (editor.selectedTab) {
    case "setup":
      return <McpSetupSection editor={editor} server={server} />;
    case "auth":
      return <McpAuthSection editor={editor} server={server} />;
    case "capabilities":
      return <McpCapabilitiesSection editor={editor} server={server} />;
    case "advanced":
      return <McpAdvancedSection editor={editor} server={server} />;
  }
};

export const McpServerDetail = ({
  editor,
  server,
  className,
}: {
  editor: McpServerEditor;
  server: ServerRecord;
  className?: string;
}): JSX.Element => {
  const enabled = getBoolean(server, "enabled", true);
  const title = getString(server, "title") || editor.selectedServerId;
  const testing =
    editor.setup.discoveryBusy &&
    editor.setup.discoveryServerId === editor.selectedServerId;
  const testUnavailableReason = !editor.setup.commandsAvailable
    ? "Select a workspace to test servers."
    : editor.selectedHasErrors
      ? "Complete the required setup fields first."
      : editor.dirty
        ? "Save changes before testing."
        : undefined;

  return (
    <TabsPrimitive.Root
      value={editor.selectedTab}
      onValueChange={(value) => editor.setSelectedTab(value as McpServerTab)}
      className={cn("grid min-w-0 content-start gap-5", className)}
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <h2 className="truncate text-lg font-semibold tracking-tight text-slate-100">
              {title}
            </h2>
            <p className="truncate font-mono text-xs text-slate-500">
              {describeServerConnection(server)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              disabled={
                editor.actionDisabled || testUnavailableReason !== undefined
              }
              tooltip={testUnavailableReason}
              onClick={editor.testSelectedServer}
              className={MCP_SECONDARY_BUTTON_CLASS}
            >
              {testing ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              Test
            </Button>
            <span className="ml-2 text-sm text-slate-300" aria-hidden="true">
              Enabled
            </span>
            <SettingsToggle
              label="Enabled"
              checked={enabled}
              disabled={editor.disabled}
              onCheckedChange={(checked) =>
                editor.updateSelectedField("enabled", checked)
              }
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`More actions for ${title}`}
                  disabled={editor.disabled}
                  className="size-9 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem onSelect={editor.duplicateSelectedServer}>
                  <Copy className="size-3.5" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={editor.removeSelectedServer}
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <TabsPrimitive.List
          aria-label="MCP server sections"
          className="flex flex-wrap gap-1 border-b border-slate-800"
        >
          {SERVER_TABS.map((tab) => (
            <TabsPrimitive.Trigger
              key={tab.value}
              value={tab.value}
              className="-mb-px h-9 shrink-0 border-b-2 border-transparent px-3 text-sm font-medium text-slate-400 outline-none transition-colors hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-sky-500/60 data-[state=active]:border-sky-400 data-[state=active]:text-slate-100"
            >
              {tab.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
      </div>
      <TabsPrimitive.Content
        value={editor.selectedTab}
        className="min-w-0 outline-none"
      >
        {renderTab(editor, server)}
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
};
