import { createRoot } from "react-dom/client";
import { CloudPanel } from "../src/tauri/ui/cloud/cloud-panel";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { Dialog } from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import "../src/tauri/ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing verification root");
createRoot(root).render(
  <CommandProvider activeView="chat" platform="windows" runtime="tauri">
    <TooltipProvider>
      <Dialog open commandOverlayId="cloud-verification">
        <CloudPanel workspaceRoot={null} />
      </Dialog>
    </TooltipProvider>
  </CommandProvider>,
);
