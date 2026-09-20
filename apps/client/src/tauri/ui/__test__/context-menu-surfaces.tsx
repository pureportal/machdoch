import { createRoot } from "react-dom/client";
import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../components/ui/dropdown-menu";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import {
  RalphCanvasSubmenu,
  RalphContextMenuButton,
} from "../ralph/components/ralph-context-menu-controls";
import { preserveNativeContextMenu } from "../lib/native-context-menu";
import "../styles.css";

document.addEventListener(
  "contextmenu",
  (event) => {
    if (!preserveNativeContextMenu(event.target)) event.preventDefault();
  },
  { capture: true },
);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="grid gap-6 p-6 text-(--app-text)">
      <CopyContextMenu
        values={[
          { label: "Copy full path", value: "C:\\workspace\\src\\index.ts" },
        ]}
      >
        <p data-testid="path" className="w-48 truncate">
          C:\workspace\src\index.ts
        </p>
      </CopyContextMenu>
      <CopyContextMenu
        values={[{ label: "Copy output", value: "First line\nSecond line" }]}
      >
        <pre data-testid="output">
          <code>First line{"\n"}Second line</code>
        </pre>
      </CopyContextMenu>
      <input aria-label="Editable text" defaultValue="Editable" />
      <button type="button">Outside</button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Visible</DropdownMenuCheckboxItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Submenu action</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>Unavailable</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        role="menu"
        aria-label="Flow actions"
        className="app-menu-surface w-56"
      >
        <RalphCanvasSubmenu label="Add block">
          <RalphContextMenuButton label="Prompt" onClick={() => undefined} />
        </RalphCanvasSubmenu>
        <RalphContextMenuButton
          label="Delete block"
          onClick={() => undefined}
          options={{ danger: true }}
        />
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">Details</button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Details</DialogTitle>
          <CopyContextMenu
            values={[{ label: "Copy diagnostic", value: "Connection failed" }]}
          >
            <p>Connection failed</p>
          </CopyContextMenu>
        </DialogContent>
      </Dialog>
    </main>
  </TooltipProvider>,
);
