import type { JSX } from "react";
import { Box, Download, LoaderCircle } from "lucide-react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { Button } from "../../components/ui/button";
import { SUBMIT_SHORTCUT_ACTION_PROPS } from "../../components/ui/submit-shortcut";
import { MediaModelInstallButton } from "./media-model-install-button";

export const MEDIA_MODEL_INSTALLING_STATES = ["queued", "downloading", "verifying", "activating"];

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
  if (model && !isMediaModelReady(model)) {
    const installing = MEDIA_MODEL_INSTALLING_STATES.includes(model.installationStatus);
    return (
      <MediaModelInstallButton model={model} onInstalled={onModelInstalled} className="w-full">
        {installing ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {installing ? `Downloading ${model.displayName}` : `Download ${model.displayName}`}
      </MediaModelInstallButton>
    );
  }
  return (
    <Button {...SUBMIT_SHORTCUT_ACTION_PROPS} className="w-full" disabled={disabled} onClick={onGenerate}>
      <Box className="h-4 w-4" />
      {pending ? "Preparing" : "Generate 3D"}
    </Button>
  );
};
