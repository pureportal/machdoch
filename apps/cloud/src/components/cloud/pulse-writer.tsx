"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import type { PulseJob } from "@/lib/cloud-pulse-contract";
import { maximumPulseProjects } from "@/lib/cloud-pulse-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import { parseAgentModelValue, useAgentModels } from "./use-agent-models";
import { useToast } from "./toast";

const pollMs = 3_000;

export function PulseWriter({
  projects,
  label = "Write with Agent",
}: {
  projects: { id: string; name: string }[];
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<PulseJob[]>([]);
  const models = useAgentModels(open);
  const sender = useRef(createCommandSender());
  const projectIds = projects.map((project) => project.id).join(",");
  const waiting = jobs.filter(
    (job) =>
      job.state === "waiting" &&
      job.projectIds.some((id) => projectIds.includes(id)),
  );
  const known = useRef<PulseJob[]>([]);
  const refresh = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<{ jobs: PulseJob[] }>("pulse/jobs", { signal })
        .then((result) => {
          const finished = result.jobs.filter(
            (job) =>
              job.state !== "waiting" &&
              known.current.find((entry) => entry.id === job.id)?.state ===
                "waiting",
          );
          known.current = result.jobs;
          setJobs(result.jobs);
          for (const job of finished)
            if (job.state === "succeeded") toast(job.detail || "Posted");
            else
              toast(job.error ?? "Agent could not write the update.", "error");
          if (finished.length) router.refresh();
        })
        .catch(() => undefined),
    [router, toast],
  );
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);
  useEffect(() => {
    if (!waiting.length) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [waiting.length, refresh]);
  if (waiting.length)
    return (
      <span className="cloud-pulse-writing" role="status">
        <LoaderCircle size={14} aria-hidden="true" />
        Agent is writing…
      </span>
    );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          sender.current = createCommandSender();
          setOpen(true);
        }}
      >
        <Sparkles aria-hidden="true" />
        {label}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={
          projects.length === 1
            ? `Update for ${projects[0]!.name}`
            : "Write Pulse updates"
        }
        submitLabel="Write"
        pendingLabel="Starting…"
        submitDisabled={!models.choices.length}
        onSubmit={async (form) => {
          const choice = parseAgentModelValue(formText(form, "model"));
          const selected =
            projects.length === 1
              ? [projects[0]!.id]
              : form.getAll("projectIds").map(String);
          if (!choice) throw new Error("Choose a model.");
          if (!selected.length) throw new Error("Choose at least one project.");
          if (selected.length > maximumPulseProjects)
            throw new Error(`Choose up to ${maximumPulseProjects} projects.`);
          const job = await sender.current<PulseJob>("pulse/jobs", {
            projectIds: selected,
            ...choice,
          });
          known.current = [job, ...known.current];
          setJobs((current) => [job, ...current]);
        }}
      >
        {projects.length > 1 && (
          <fieldset className="cloud-check-grid">
            <legend>Projects</legend>
            {projects.map((project, index) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  name="projectIds"
                  value={project.id}
                  defaultChecked={index < maximumPulseProjects}
                />
                {project.name}
              </label>
            ))}
          </fieldset>
        )}
        <Field label="Model" htmlFor="pulse-model">
          {models.loaded && !models.choices.length ? (
            <p className="cloud-field-note" id="pulse-model">
              {models.error || "Add an AI provider to write with Agent."}
            </p>
          ) : (
            <Select
              id="pulse-model"
              name="model"
              key={models.preferred}
              defaultValue={models.preferred}
              disabled={!models.loaded}
            >
              {models.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </FormDialog>
    </>
  );
}
