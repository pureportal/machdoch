import { useState } from "react";
import type { MediaVideoRecipeSettings } from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { MediaRefModControls } from "./media-refmod-controls";

export function MediaRefModLibraryAction({
  workspaceRoot,
}: {
  workspaceRoot: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<
    Pick<MediaVideoRecipeSettings, "refMods" | "refModMaxTokens">
  >({ refMods: [] });
  return (
    <div className="space-y-3">
      <Button
        size="sm"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Close RefMods" : "RefMods"}
      </Button>
      {open && (
        <MediaRefModControls
          workspaceRoot={workspaceRoot}
          mode="library"
          settings={settings}
          onChange={setSettings}
          onBusyChange={setBusy}
        />
      )}
    </div>
  );
}
