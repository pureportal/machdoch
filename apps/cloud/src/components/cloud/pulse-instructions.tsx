"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import {
  defaultPulseInstructions,
  type PulseInstructions,
} from "@/lib/cloud-pulse-contract";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { MarkdownTextarea } from "./markdown-textarea";
import { useToast } from "./toast";

export function PulseInstructionsEditor() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setText(null);
    cloudRequest<PulseInstructions>("pulse/instructions", {
      signal: abort.signal,
    })
      .then((result) => setText(result.instructions))
      .catch((reason: Error) => {
        if (!abort.signal.aborted) toast(reason.message, "error");
      });
    return () => abort.abort();
  }, [open, toast]);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <FileText aria-hidden="true" />
        Instructions
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Pulse instructions"
        submitLabel="Save"
        submitDisabled={text === null}
        onSubmit={async () => {
          await cloudRequest("pulse/instructions", {
            method: "PUT",
            body: { instructions: text ?? "" },
          });
          toast("Instructions saved");
        }}
      >
        <MarkdownTextarea
          aria-label="Instructions"
          className="cloud-pulse-instructions"
          value={text ?? ""}
          disabled={text === null}
          maxLength={20000}
          rows={18}
          onChange={(event) => setText(event.target.value)}
        />
        {text !== null && text !== defaultPulseInstructions && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => setText(defaultPulseInstructions)}
          >
            Restore default
          </Button>
        )}
      </FormDialog>
    </>
  );
}
