import { useState, type JSX } from "react";
import type {
  MediaModelAddonRemovalPlan,
  MediaModelRemovalPlan,
} from "../../../../core/media/contracts.js";
import {
  planMediaModelAddonRemoval,
  planMediaModelRemoval,
  removeMediaModel,
  removeMediaModelAddon,
} from "../media-runtime";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

export const MediaRemoveResourceButton = ({
  id,
  kind,
  onRemoved,
  disabled = false,
}: {
  id: string;
  kind: "model" | "addon";
  onRemoved: () => Promise<void>;
  disabled?: boolean;
}): JSX.Element => {
  const [plan, setPlan] = useState<
    MediaModelRemovalPlan | MediaModelAddonRemovalPlan | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPlan(
        kind === "model"
          ? await planMediaModelRemoval(id)
          : await planMediaModelAddonRemoval(id),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Removal could not be checked. Retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (!plan?.canRemove) return;
    setBusy(true);
    setError(null);
    try {
      if ("modelId" in plan)
        await removeMediaModel({
          modelId: plan.modelId,
          confirmationToken: plan.confirmationToken,
          confirmRemoval: true,
        });
      else
        await removeMediaModelAddon({
          addonId: plan.addonId,
          confirmationToken: plan.confirmationToken,
          confirmRemoval: true,
        });
      await onRemoved();
      setPlan(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Removal failed. Retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-rose-300"
        disabled={busy || disabled}
        onClick={() => void review()}
      >
        Remove {kind === "model" ? "model" : "add-on"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      {plan ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setPlan(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {plan.displayName}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-300">
              Its installed files will be deleted. Saved results will remain.
            </p>
            {!plan.canRemove ? (
              <p role="alert">Wait for generation or installation to finish.</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-rose-300">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPlan(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !plan.canRemove}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
};
