import { useEffect, useRef, useState, type JSX } from "react";
import type {
  MediaModelDescriptor,
  MediaModelInstallJob,
  MediaModelInstallPlan,
} from "../../../../core/media/contracts.js";
import {
  cancelMediaModelInstall,
  getMediaModelInstallJob,
  planMediaModelInstall,
  startMediaModelInstall,
} from "../media-runtime";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

export const MediaModelInstallDialog = ({
  model,
  onClose,
  onInstalled,
}: {
  model: MediaModelDescriptor;
  onClose: () => void;
  onInstalled: () => Promise<void>;
}): JSX.Element => {
  const [plan, setPlan] = useState<MediaModelInstallPlan | null>(null);
  const [job, setJob] = useState<MediaModelInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const callbacks = useRef({ onInstalled, onClose });
  callbacks.current = { onInstalled, onClose };
  const active =
    job !== null && !["installed", "failed", "canceled"].includes(job.status);
  const fail = (cause: unknown): void =>
    setError(
      cause instanceof Error
        ? cause.message
        : "Installation could not finish. Check your connection and retry.",
    );
  useEffect(() => {
    let disposed = false;
    void planMediaModelInstall(model.id)
      .then((value) => {
        if (!disposed) setPlan(value);
      })
      .catch((cause) => {
        if (!disposed) fail(cause);
      });
    return () => {
      disposed = true;
    };
  }, [model.id]);
  useEffect(() => {
    if (!active || !job) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await getMediaModelInstallJob(job.id);
        if (disposed) return;
        setJob(next);
        if (next.status === "installed") {
          setBusy(true);
          await callbacks.current.onInstalled();
          if (!disposed) callbacks.current.onClose();
        } else if (next.status === "failed") {
          setError(
            next.failure?.message ?? "Installation failed. Retry the download.",
          );
        } else if (next.status !== "canceled")
          timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (!disposed) {
          fail(cause);
          timer = setTimeout(() => void poll(), 3000);
        }
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [job?.id]);
  const install = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const latest = await planMediaModelInstall(model.id);
      setPlan(latest);
      if (latest.alreadyInstalled) {
        await onInstalled();
        onClose();
        return;
      }
      setJob(
        await startMediaModelInstall({
          modelId: latest.modelId,
          reviewToken: latest.reviewToken,
          manifestDigest: latest.manifestDigest,
          licenseDigest: latest.licenseDigest,
          acceptLicense: !latest.license.requiresAcceptance || accepted,
        }),
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !active && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {model.displayName}</DialogTitle>
        </DialogHeader>
        {plan ? (
          <>
            <p className="text-sm text-slate-300">
              {(plan.totalBytes / 1024 ** 3).toFixed(1)} GB download ·{" "}
              {(plan.requiredWorkingBytes / 1024 ** 3).toFixed(1)} GB free space
              needed
            </p>
            <a
              href={plan.license.sourceUrl ?? plan.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-sky-300 underline"
            >
              {plan.license.name}
            </a>
            {plan.license.requiresAcceptance ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                Accept license
              </label>
            ) : null}
            {plan.hasSufficientSpace === false ? (
              <p role="alert" className="text-sm text-rose-300">
                Free up disk space, then retry.
              </p>
            ) : null}
          </>
        ) : (
          <p role="status">Checking download…</p>
        )}
        {active ? (
          <div role="status" className="space-y-2">
            <p>
              {job.status === "verifying"
                ? "Checking files"
                : job.status === "activating"
                  ? "Finishing installation"
                  : "Downloading"}{" "}
              · {Math.round(job.progress * 100)}%
            </p>
            <progress className="w-full" value={job.progress} max={1} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy || job?.status === "activating"}
            onClick={() => {
              if (!active || !job) {
                onClose();
                return;
              }
              void cancelMediaModelInstall(job.id).then(setJob).catch(fail);
            }}
          >
            {active ? "Cancel download" : "Close"}
          </Button>
          {!active ? (
            <Button
              onClick={() => void install()}
              disabled={
                busy ||
                !plan ||
                plan.hasSufficientSpace === false ||
                (plan.license.requiresAcceptance && !accepted)
              }
            >
              {busy
                ? "Checking model…"
                : error
                  ? "Retry installation"
                  : "Install model"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
