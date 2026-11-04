import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { FolderOpen, Link2, MoreHorizontal, Trash2 } from "lucide-react";
import type { JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  getManagedWorkspaceName,
  type ManagedWorkspaceView,
} from "./workspace-management-model";

export const WorkspaceDetailHeader = ({
  workspace,
  manageDisabled,
  onOpenFolder,
  onRelink,
  onRemove,
}: {
  workspace: ManagedWorkspaceView;
  manageDisabled: boolean;
  onOpenFolder: () => void;
  onRelink: () => void;
  onRemove: () => void;
}): JSX.Element => {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-900 px-4 py-2">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-slate-100">
          {getManagedWorkspaceName(workspace)}
        </h2>
        <CopyContextMenu
          values={[{ label: "Copy workspace path", value: workspace.root }]}
        >
          <p className="truncate font-mono text-[11px] text-slate-500">
            {workspace.root}
          </p>
        </CopyContextMenu>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Open folder"
        onClick={onOpenFolder}
      >
        <FolderOpen className="size-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Workspace actions"
            tooltip={null}
            disabled={manageDisabled}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onSelect={onRelink}>
            <Link2 className="size-3.5" />
            Relink folder…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-3.5" />
            Remove workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
};
