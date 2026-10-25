import { Cloud } from "lucide-react";
import { Tabs } from "radix-ui";
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { RemoteAccessPanel } from "./remote-access-panel";
import { CloudWorkspacesPanel } from "./workspaces-panel";

export function CloudPanel({
  workspaceRoot,
}: {
  workspaceRoot: string | null;
}) {
  const tabClass =
    "border-b-2 border-transparent px-4 py-3 text-sm text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 data-[state=active]:border-sky-400 data-[state=active]:text-slate-100";
  return (
    <DialogContent
      className="app-cloud-dialog flex max-h-[calc(100dvh-28px)] w-[min(640px,calc(100vw-28px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 transition-none sm:max-w-none"
      aria-describedby={undefined}
    >
      <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12 text-left">
        <DialogTitle className="flex items-center gap-2 text-xl">
          <Cloud className="size-5 text-sky-300" />
          machdoch.cloud
        </DialogTitle>
      </DialogHeader>
      <Tabs.Root defaultValue="workspaces" className="flex min-h-0 flex-col">
        <Tabs.List
          aria-label="Cloud connection settings"
          className="flex shrink-0 border-b border-slate-800 px-2"
        >
          <Tabs.Trigger className={tabClass} value="workspaces">
            Workspaces
          </Tabs.Trigger>
          <Tabs.Trigger className={tabClass} value="remote">
            Remote access
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content
          value="workspaces"
          className="min-h-0 overflow-y-auto outline-none"
        >
          <CloudWorkspacesPanel workspaceRoot={workspaceRoot ?? ""} />
        </Tabs.Content>
        <Tabs.Content
          value="remote"
          className="min-h-0 overflow-y-auto outline-none"
        >
          <RemoteAccessPanel />
        </Tabs.Content>
      </Tabs.Root>
    </DialogContent>
  );
}
