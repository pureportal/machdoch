"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, Copy, Sparkles, X } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type {
  TriageDecisionInput,
  TriageResult,
} from "@/lib/cloud-triage-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formText } from "./api-client";
import { useAgentShell } from "./agent/agent-shell";
import { StateIcon } from "./issue-properties";
import { PropertyMenu } from "./property-menu";
import { RelationPicker } from "./relation-picker";
import { useToast } from "./toast";

const triagePrompt =
  "Triage this issue. Look for duplicates, suggest priority, assignee and labels, and propose a decision.";

export function TriageActions({
  issue,
  workspace,
  onDecided,
}: {
  issue: Pick<CloudIssue, "id" | "identifier" | "teamId" | "revision">;
  workspace: CloudWorkspace;
  onDecided: (result: TriageResult, message: string) => void;
}) {
  const toast = useToast();
  const shell = useAgentShell();
  const sender = useRef(createCommandSender());
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<"decline" | "duplicate" | null>(null);
  const [original, setOriginal] = useState<CloudIssue | null>(null);
  const statuses =
    workspace.workflows
      .find((workflow) => workflow.teamId === issue.teamId)
      ?.statuses.filter(
        (status) => !status.archived && status.category !== "triage",
      ) ?? [];
  const send = (decision: TriageDecisionInput) =>
    sender.current<TriageResult>(`issues/${issue.id}/triage`, decision);
  const accept = async (statusId: string | null) => {
    const status = statuses.find((entry) => entry.id === statusId) ?? null;
    setPending(true);
    try {
      const result = await send({
        decision: "accept",
        revision: issue.revision,
        status: status && { id: status.id, revision: status.revision },
      });
      onDecided(result, `${issue.identifier} moved to ${result.statusName}`);
    } catch (reason) {
      toast((reason as Error).message, "error");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="cloud-triage-actions">
      <div className="cloud-triage-accept">
        <Button size="sm" disabled={pending} onClick={() => void accept(null)}>
          <Check />
          Accept
        </Button>
        <PropertyMenu
          label="Accept into"
          align="start"
          options={statuses.map((status) => ({
            value: status.id,
            label: status.name,
            icon: <StateIcon state={status.category} />,
          }))}
          onSelect={(value) => void accept(value)}
        >
          <Button size="sm" aria-label="Accept into status" disabled={pending}>
            <ChevronDown />
          </Button>
        </PropertyMenu>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setDialog("duplicate")}
      >
        <Copy />
        Duplicate
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setDialog("decline")}
      >
        <X />
        Decline
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="cloud-triage-agent"
        onClick={() => shell.openPanel(null, triagePrompt)}
      >
        <Sparkles />
        Ask Agent
      </Button>
      <FormDialog
        open={dialog === "decline"}
        onOpenChange={(open) => setDialog(open ? "decline" : null)}
        title={`Decline ${issue.identifier}`}
        submitLabel="Decline"
        onSubmit={async (form) => {
          const result = await send({
            decision: "decline",
            revision: issue.revision,
            reason: formText(form, "reason"),
          });
          setDialog(null);
          onDecided(result, `${issue.identifier} declined`);
        }}
      >
        <Field label="Reason" htmlFor="triage-decline-reason">
          <Textarea
            id="triage-decline-reason"
            name="reason"
            rows={4}
            maxLength={20000}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={dialog === "duplicate"}
        onOpenChange={(open) => {
          setDialog(open ? "duplicate" : null);
          if (!open) setOriginal(null);
        }}
        title={`Mark ${issue.identifier} as duplicate`}
        submitLabel="Mark as duplicate"
        submitDisabled={!original}
        onSubmit={async () => {
          if (!original) return;
          const result = await send({
            decision: "duplicate",
            revision: issue.revision,
            duplicateOfId: original.id,
          });
          setDialog(null);
          onDecided(
            result,
            `${issue.identifier} marked as a duplicate of ${original.identifier}`,
          );
        }}
      >
        {dialog === "duplicate" && (
          <RelationPicker
            issueId={issue.id}
            selected={original}
            onSelect={setOriginal}
          />
        )}
      </FormDialog>
    </div>
  );
}
