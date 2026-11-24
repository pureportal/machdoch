import { CircleDot, ListFilter, Plus, TerminalSquare } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import type { ResolvedTerminalProfiles } from "./workspace-terminal-profiles";
import type { WorkspaceTerminalStore } from "./workspace-terminal-store";

export const WorkspaceTerminalNewMenu = ({
  store,
  profiles,
}: {
  store: WorkspaceTerminalStore;
  profiles: ResolvedTerminalProfiles;
}): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        aria-label="New terminal"
        tooltip="New terminal"
      >
        <Plus className="size-3.5" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-44">
      {profiles.visibleShells.map((shell) => (
        <DropdownMenuItem
          key={shell.id}
          onSelect={() => void store.createTerminal(shell.id)}
        >
          <TerminalSquare className="size-3.5" />
          {shell.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <ListFilter className="size-3.5" />
          Profiles
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-48">
          {profiles.availableShells.map((shell) => {
            const visible = profiles.visibleShells.some(
              (candidate) => candidate.id === shell.id,
            );
            return (
              <DropdownMenuCheckboxItem
                key={shell.id}
                checked={visible}
                disabled={visible && profiles.visibleShells.length === 1}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => {
                  if (typeof checked === "boolean")
                    void store.setShellVisibility(shell.id, checked);
                }}
              >
                {shell.label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <CircleDot className="size-3.5" />
          Default
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-48">
          <DropdownMenuRadioGroup
            value={profiles.defaultShellId ?? undefined}
            onValueChange={(shellId) => void store.setDefaultShell(shellId)}
          >
            {profiles.visibleShells.map((shell) => (
              <DropdownMenuRadioItem key={shell.id} value={shell.id}>
                {shell.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>
);
