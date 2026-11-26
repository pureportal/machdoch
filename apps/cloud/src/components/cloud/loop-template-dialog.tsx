"use client";

import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type {
  CloudDocumentSummary,
  CloudLoop,
  LoopExecutor,
} from "@/lib/cloud-loop-contract";
import { loopTemplateProblem, loopTemplates } from "@/lib/loop-templates";
import { createCommandSender } from "./api-client";
import { LoopExecutorFields, targetOptions } from "./loop-executor-fields";
import type { AutomationOptions } from "./use-automation-options";

const newDocument = "new";

const automaticExecutor: LoopExecutor = {
  placement: "automatic",
  targetId: null,
  harness: "machdoch",
  model: "",
  capabilities: [],
};

export function LoopTemplateDialog({
  workspace,
  options,
  initialTeamId,
  onClose,
  onInstalled,
}: {
  workspace: CloudWorkspace;
  options: AutomationOptions;
  initialTeamId: string;
  onClose: () => void;
  onInstalled: (loop: CloudLoop) => void;
}) {
  const sender = useRef(createCommandSender());
  const [teamId, setTeamId] = useState(initialTeamId);
  const [templateId, setTemplateId] = useState(loopTemplates[0]?.id ?? "");
  const [executor, setExecutor] = useState(automaticExecutor);
  const [modelIndex, setModelIndex] = useState(0);
  const [documentId, setDocumentId] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const template = loopTemplates.find((entry) => entry.id === templateId);
  const documents = options.documents.filter(
    (document) => document.teamId === teamId,
  );
  const selectedDocument = documentId || documents[0]?.id || newDocument;
  const model = options.models[modelIndex];

  async function install() {
    if (!template || !model) return;
    let chosenDocument: string | null = null;
    if (template.needsDocument) {
      chosenDocument =
        selectedDocument === newDocument
          ? (
              await sender.current<CloudDocumentSummary>("loops/documents", {
                teamId,
                title: documentTitle,
              })
            ).id
          : selectedDocument;
    }
    const input = {
      templateId: template.id,
      teamId,
      executor: { ...executor, model: model.model },
      providerId: model.providerId,
      model: model.model,
      documentId: chosenDocument,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const problem = loopTemplateProblem(template, input);
    if (problem) throw new Error(problem);
    onInstalled(await sender.current<CloudLoop>("loops/templates", input));
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New automation from template"
      submitLabel="Install"
      pendingLabel="Installing…"
      submitDisabled={
        !template ||
        !model ||
        !options.loaded ||
        (executor.placement !== "automatic" && !executor.targetId)
      }
      onSubmit={install}
    >
      <div className="cloud-form-grid">
        <div className="cloud-form-span">
          <Field label="Template" htmlFor="loop-template">
            <Select
              id="loop-template"
              value={templateId}
              onChange={(event) => {
                const next = loopTemplates.find(
                  (entry) => entry.id === event.target.value,
                );
                setTemplateId(event.target.value);
                if (
                  next?.placements &&
                  !next.placements.includes(executor.placement)
                ) {
                  const placement = next.placements[0] ?? "automatic";
                  setExecutor({
                    ...automaticExecutor,
                    placement,
                    targetId:
                      targetOptions(placement, options, teamId)[0]?.id ?? null,
                  });
                }
              }}
            >
              {loopTemplates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Team" htmlFor="loop-template-team">
          <Select
            id="loop-template-team"
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setDocumentId("");
              if (executor.placement === "sandbox")
                setExecutor({
                  ...executor,
                  targetId:
                    targetOptions("sandbox", options, event.target.value)[0]
                      ?.id ?? null,
                });
            }}
          >
            {workspace.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" htmlFor="loop-template-model">
          <Select
            id="loop-template-model"
            value={String(modelIndex)}
            onChange={(event) => setModelIndex(Number(event.target.value))}
          >
            {options.models.map((entry, index) => (
              <option key={`${entry.providerId}/${entry.model}`} value={index}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <LoopExecutorFields
          executor={executor}
          options={options}
          teamId={teamId}
          placements={template?.placements ?? undefined}
          onChange={setExecutor}
        />
        {template?.needsDocument && (
          <>
            <Field label="Document" htmlFor="loop-template-document">
              <Select
                id="loop-template-document"
                value={selectedDocument}
                onChange={(event) => setDocumentId(event.target.value)}
              >
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))}
                <option value={newDocument}>New document</option>
              </Select>
            </Field>
            {selectedDocument === newDocument && (
              <Field label="Document title" htmlFor="loop-template-title">
                <Input
                  id="loop-template-title"
                  value={documentTitle}
                  required
                  maxLength={200}
                  onChange={(event) => setDocumentTitle(event.target.value)}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </FormDialog>
  );
}
