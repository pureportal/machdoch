"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { MarkdownTextarea } from "./markdown-textarea";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { createCommandSender, formText } from "./api-client";
import { draftForTeam, IssueDraftProperties } from "./issue-draft-properties";
import { noValue } from "./issue-properties";

export function CreateIssue({
  workspace,
  teamId,
  projectId,
  cycleId,
  parent,
  onCreated,
  shortcut = false,
  autoOpen = false,
  defaults,
  compactLabel,
}: {
  workspace: CloudWorkspace;
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  parent?: CloudIssue;
  onCreated?: () => Promise<void>;
  shortcut?: boolean;
  autoOpen?: boolean;
  defaults?: Pick<
    IssueChangeSet,
    "status" | "priority" | "assigneeId" | "projectId" | "cycleId"
  >;
  compactLabel?: string;
}) {
  const initialTeam = teamId ?? workspace.teams[0]?.id ?? "";
  const initialDraft = () =>
    draftForTeam(workspace, initialTeam, {
      status: defaults?.status
        ? JSON.stringify({
            id: defaults.status.id,
            revision: defaults.status.revision,
          })
        : undefined,
      priority: defaults?.priority,
      assigneeId: defaults?.assigneeId ?? undefined,
      projectId: defaults?.projectId ?? projectId,
      cycleId: defaults?.cycleId ?? cycleId,
    });
  const [open, setOpen] = useState(autoOpen);
  const [team, setTeam] = useState(initialTeam);
  const [draft, setDraft] = useState(initialDraft);
  const sender = useRef(createCommandSender());
  function openDialog() {
    setTeam(initialTeam);
    setDraft(initialDraft());
    setOpen(true);
  }
  const router = useRouter();
  const available =
    holderCan(workspace.actor, "issues.edit") && workspace.teams.length > 0;
  useEffect(() => {
    if (!shortcut || !available) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key.toLowerCase() !== "c" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.defaultPrevented ||
        target?.closest("input,textarea,select,[contenteditable],[role=dialog]")
      )
        return;
      event.preventDefault();
      openDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut, available]);
  if (!available) return null;
  return (
    <>
      {compactLabel ? (
        <button
          type="button"
          className="cloud-icon-button"
          aria-label={compactLabel}
          onClick={openDialog}
        >
          <Plus size={14} />
        </button>
      ) : (
        <Button
          onClick={openDialog}
          aria-keyshortcuts={shortcut ? "C" : undefined}
          title={shortcut ? "New issue (C)" : undefined}
        >
          <Plus />
          {parent ? "New sub-issue" : "New issue"}
        </Button>
      )}
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) sender.current = createCommandSender();
        }}
        title={parent ? "New sub-issue" : "New issue"}
        submitLabel="Create issue"
        onSubmit={async (form) => {
          const chosen = (value: string) => (value === noValue ? null : value);
          const input = {
            teamId: team,
            title: formText(form, "title"),
            description: formText(form, "description"),
            status: draft.status.startsWith("{")
              ? (JSON.parse(draft.status) as { id: string; revision: number })
              : null,
            priority: draft.priority,
            assigneeId: chosen(draft.assigneeId),
            projectId: chosen(draft.projectId),
            cycleId: chosen(draft.cycleId),
          };
          const result = await sender.current<{ id: string }>(
            parent ? `issues/${parent.id}/children` : "issues",
            parent ? { parentRevision: parent.revision, issue: input } : input,
          );
          if (onCreated) await onCreated();
          else {
            router.push(`/cloud/issues/${result.id}`);
            router.refresh();
          }
        }}
      >
        <Field label="Team" htmlFor="issue-team">
          <Select
            id="issue-team"
            value={team}
            onChange={(event) => {
              setTeam(event.target.value);
              setDraft(draftForTeam(workspace, event.target.value, draft));
            }}
            required
          >
            {workspace.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="issue-title">
          <Input
            id="issue-title"
            name="title"
            maxLength={300}
            required
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor="issue-description">
          <MarkdownTextarea
            id="issue-description"
            name="description"
            maxLength={30000}
          />
        </Field>
        <IssueDraftProperties
          workspace={workspace}
          teamId={team}
          draft={draft}
          onChange={setDraft}
        />
      </FormDialog>
    </>
  );
}
