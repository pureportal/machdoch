import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MediaStudio } from "@machdoch/media-studio/tauri/ui/media/media-studio.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { RalphFlowEditor } from "../../ralph/ralph-flow-editor";

const Designers = () => {
  const [designer, setDesigner] = useState("ralph");
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
        <nav className="flex h-10 shrink-0 gap-4 px-4" aria-label="Designers">
          <button onClick={() => setDesigner("ralph")}>RALPH</button>
          <button onClick={() => setDesigner("media")}>Media Studio</button>
        </nav>
        {designer === "ralph" ? (
          <RalphFlowEditor
            workspaceRoot="C:/flow-designer-test"
            runMode="machdoch"
            generationProvider="openai"
            generationModel="test-model"
            runProvider="openai"
            runModel="test-model"
          />
        ) : (
          <MediaStudio
            workspaceRoot={null}
            openSection="flow"
            providerStatuses={[]}
            onOpenPoseChat={() => {}}
            onOpenProviderSettings={() => {}}
          />
        )}
      </div>
    </TooltipProvider>
  );
};

createRoot(document.getElementById("root")!).render(<Designers />);
