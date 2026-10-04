import { useEffect, useRef, useState, type JSX } from "react";
import type {
  MediaModelDescriptor,
  MediaModelInstallJob,
  MediaModelInstallPlan,
} from "../../../../core/media/contracts.js";
import {
  planMediaModelInstall,
  startMediaModelInstall,
  getMediaModelInstallJob,
  cancelMediaModelInstall,
} from "../media-runtime";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

const activeJob = (job: MediaModelInstallJob | null): boolean =>
  job !== null &&
  ["queued", "downloading", "verifying", "activating", "canceling"].includes(
    job.status,
  );

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
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobMutation = useRef(0);
  useEffect(() => {
    let current = true;
    void planMediaModelInstall(model.id)
      .then((result) => {
        if (current) {
          setPlan(result);
          setJob(result.activeJob);
          setAccepted(
            result.activeJob?.manifestDigest === result.manifestDigest,
          );
        }
      })
      .catch((failure: unknown) => {
        if (current) setError(String(failure));
      });
    return () => {
      current = false;
    };
  }, [model.id]);
  const jobId = job?.id;
  const active = activeJob(job);
  useEffect(() => {
    if (!jobId || !active) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const mutation = jobMutation.current;
      try {
        const result = await getMediaModelInstallJob(jobId);
        if (!current) return;
        if (mutation !== jobMutation.current) {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        setJob(result);
        if (result.status === "installed") await onInstalled();
        if (current && activeJob(result))
          timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (current) setError(String(failure));
      }
    };
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [jobId, active, onInstalled]);
  const start = async (): Promise<void> => {
    if (!plan) return;
    jobMutation.current += 1;
    setPending(true);
    setError(null);
    try {
      const result = await startMediaModelInstall({
        modelId: model.id,
        reviewToken: plan.reviewToken,
        manifestDigest: plan.manifestDigest,
        licenseDigest: plan.licenseDigest,
        acceptLicense: accepted || !plan.license.requiresAcceptance,
      });
      setJob(result);
      if (result.status === "installed") await onInstalled();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (!job) return;
    jobMutation.current += 1;
    setPending(true);
    try {
      setJob(await cancelMediaModelInstall(job.id));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{model.displayName}</DialogTitle>
        </DialogHeader>
        {plan ? (
          <>
            <p className="text-sm text-slate-300">
              {(plan.totalBytes / 1e9).toFixed(1)} GB download ·{" "}
              {(plan.requiredWorkingBytes / 1e9).toFixed(1)} GB free space
              needed
            </p>
            {!active &&
            job?.status !== "installed" &&
            !plan.alreadyInstalled &&
            plan.license.requiresAcceptance ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                I accept{" "}
                <a
                  href={plan.license.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-300 underline"
                >
                  {plan.license.name}
                </a>
              </label>
            ) : null}
            {plan.hasSufficientSpace === false ? (
              <p role="alert">Free up space, then reopen this download.</p>
            ) : null}
          </>
        ) : !error ? (
          <p role="status">Preparing download…</p>
        ) : null}
        {job ? (
          <div className="space-y-2">
            <p role="status" className="capitalize">
              {job.status} · {Math.round(job.progress * 100)}%
            </p>
            <progress className="w-full" value={job.progress} max={1} />
            <p className="truncate text-xs text-slate-400">{job.currentFile}</p>
          </div>
        ) : null}
        {error || job?.error ? (
          <p role="alert" className="text-sm text-rose-300">
            {error ?? job?.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {active ? (
            <Button
              variant="outline"
              onClick={() => void cancel()}
              disabled={pending || job?.status === "canceling"}
            >
              Cancel download
            </Button>
          ) : job?.status === "installed" || plan?.alreadyInstalled ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button
              onClick={() => void start()}
              disabled={
                pending ||
                !plan ||
                (plan.license.requiresAcceptance && !accepted) ||
                plan.hasSufficientSpace === false
              }
            >
              {job ? "Retry download" : "Download model"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
