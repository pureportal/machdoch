import { Trash2 } from "lucide-react";
import type { JSX } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
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

  return (
    <TabsPrimitive.Root
      value={editor.selectedTab}
      onValueChange={(value) => editor.setSelectedTab(value as McpServerTab)}
      className={cn("grid min-w-0 content-start gap-5", className)}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="grid min-w-0 gap-1">
            <h2 className="truncate text-lg font-semibold tracking-tight text-slate-100">
              {getString(server, "title") || editor.selectedServerId}
            </h2>
            <p className="truncate font-mono text-xs text-slate-500">
              {editor.selectedServerId}
              <span aria-hidden="true"> · </span>
              {describeServerConnection(server)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span aria-hidden="true" className="text-sm text-slate-300">
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
            <Button
              type="button"
              variant="ghost"
              disabled={editor.disabled}
              onClick={editor.removeSelectedServer}
              className="ml-2 h-9 rounded-lg px-3 text-sm text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
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
