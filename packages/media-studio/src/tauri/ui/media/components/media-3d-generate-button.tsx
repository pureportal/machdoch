import type { JSX } from "react";
import { Box } from "lucide-react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { Button } from "../../components/ui/button";
import { SUBMIT_SHORTCUT_ACTION_PROPS } from "../../components/ui/submit-shortcut";
import { MediaModelDownload } from "./media-model-download";

export const Media3dGenerateButton = ({
  model,
  disabled,
  pending,
  onGenerate,
  onModelInstalled,
}: {
  model: MediaModelDescriptor | null;
  disabled: boolean;
  pending: boolean;
  onGenerate: () => void;
  onModelInstalled: () => Promise<void>;
}): JSX.Element => {
  if (model && !isMediaModelReady(model))
    return (
      <MediaModelDownload model={model} onInstalled={onModelInstalled}>
        Download {model.displayName}
      </MediaModelDownload>
    );
  return (
    <Button {...SUBMIT_SHORTCUT_ACTION_PROPS} className="w-full" disabled={disabled} onClick={onGenerate}>
      <Box className="h-4 w-4" />
      {pending ? "Preparing" : "Generate 3D"}
    </Button>
  );
};
