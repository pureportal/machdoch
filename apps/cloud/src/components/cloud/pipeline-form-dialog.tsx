"use client";

import { useRef } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import {
  pipelineSourceLabels,
  pipelineSources,
  pipelineTypes,
  type CloudPipeline,
  type CreatedPipeline,
} from "@/lib/cloud-release-pipeline-contract";
import { createCommandSender, formText } from "./api-client";

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function PipelineFormDialog({
  workspace,
  repositories,
  pipeline,
  onClose,
  onSaved,
}: {
  workspace: CloudWorkspace;
  repositories: GitRepositoryOption[];
  pipeline: CloudPipeline | null;
  onClose: () => void;
  onSaved: (result: CreatedPipeline) => void;
}) {
  const sender = useRef(createCommandSender());
  const teamIds = new Set(pipeline?.teams.map((team) => team.id) ?? []);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={pipeline ? "Edit pipeline" : "New pipeline"}
      submitLabel={pipeline ? "Save" : "Create pipeline"}
      onSubmit={async (form) => {
        const fields = {
          name: formText(form, "name"),
          teamIds: form.getAll("teamIds").map(String),
          repositoryId: formText(form, "repositoryId") || null,
          paths: lines(formText(form, "paths")),
          type: formText(form, "type"),
          source: formText(form, "source"),
          environments: lines(formText(form, "environments")),
        };
        onSaved(
          pipeline
            ? await sender.current<CreatedPipeline>(
                `release-pipelines/${pipeline.id}`,
                {
                  ...fields,
                  revision: pipeline.revision,
                  archived: pipeline.archived,
                },
                "PATCH",
              )
            : await sender.current<CreatedPipeline>(
                "release-pipelines",
                fields,
              ),
        );
      }}
    >
      <Field label="Name" htmlFor="pipeline-name">
        <Input
          id="pipeline-name"
          name="name"
          required
          maxLength={100}
          defaultValue={pipeline?.name}
          autoFocus
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Teams</legend>
        {workspace.teams.map((team) => (
          <label key={team.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="teamIds"
              value={team.id}
              defaultChecked={teamIds.has(team.id)}
            />
            {team.name}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="pipeline-type">
          <Select
            id="pipeline-type"
            name="type"
            defaultValue={pipeline?.type ?? "continuous"}
          >
            {pipelineTypes.map((type) => (
              <option key={type} value={type}>
                {type === "continuous" ? "Continuous" : "Scheduled"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source" htmlFor="pipeline-source">
          <Select
            id="pipeline-source"
            name="source"
            defaultValue={pipeline?.source ?? "deployment"}
          >
            {pipelineSources.map((source) => (
              <option key={source} value={source}>
                {pipelineSourceLabels[source]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Repository" htmlFor="pipeline-repository">
        <Select
          id="pipeline-repository"
          name="repositoryId"
          defaultValue={pipeline?.repositoryId ?? ""}
        >
          <option value="">None</option>
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.fullName}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Paths" htmlFor="pipeline-paths">
          <Textarea
            id="pipeline-paths"
            name="paths"
            rows={4}
            placeholder="apps/web/**"
            defaultValue={pipeline?.paths.join("\n")}
          />
        </Field>
        <Field label="Environments" htmlFor="pipeline-environments">
          <Textarea
            id="pipeline-environments"
            name="environments"
            rows={4}
            required
            placeholder={"staging\nproduction"}
            defaultValue={pipeline?.environments.join("\n") ?? "production"}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
