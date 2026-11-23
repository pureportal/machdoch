"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { LoopMemoryEntry } from "@/lib/cloud-loop-contract";
import { createCommandSender } from "./api-client";
import { useToast } from "./toast";

export function LoopMemory({
  loopId,
  memory,
  editable,
}: {
  loopId: string;
  memory: LoopMemoryEntry[];
  editable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState<LoopMemoryEntry | null>(null);
  const [pending, setPending] = useState(false);

  async function remove(key: string) {
    setPending(true);
    try {
      await sender.current(
        `loops/${loopId}/memory/${encodeURIComponent(key)}`,
        undefined,
        "DELETE",
      );
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="cloud-loop-section" aria-labelledby="loop-memory">
      <header>
        <h2 id="loop-memory">Memory</h2>
        {editable && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Add memory"
            onClick={() => setEditing({ key: "", value: "" })}
          >
            <Plus />
          </Button>
        )}
      </header>
      {memory.length ? (
        <dl className="cloud-automation-facts">
          {memory.map((entry) => (
            <div key={entry.key} className="contents">
              <dt>{entry.key}</dt>
              <dd className="cloud-loop-memory-value">
                <span>{entry.value}</span>
                {editable && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${entry.key}`}
                      disabled={pending}
                      onClick={() => setEditing(entry)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${entry.key}`}
                      disabled={pending}
                      onClick={() => void remove(entry.key)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Empty</p>
      )}
      {editing && (
        <FormDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={editing.key ? "Edit memory" : "Add memory"}
          submitLabel="Save"
          onSubmit={async (form) => {
            await sender.current(
              `loops/${loopId}/memory`,
              {
                key: String(form.get("key") ?? ""),
                value: String(form.get("value") ?? ""),
              },
              "PUT",
            );
            router.refresh();
          }}
        >
          <Field label="Key" htmlFor="loop-memory-key">
            <Input
              id="loop-memory-key"
              name="key"
              required
              maxLength={64}
              pattern="[a-z0-9][a-z0-9_.\-]{0,63}"
              defaultValue={editing.key}
              readOnly={Boolean(editing.key)}
            />
          </Field>
          <Field label="Value" htmlFor="loop-memory-value">
            <Textarea
              id="loop-memory-value"
              name="value"
              maxLength={4000}
              defaultValue={editing.value}
            />
          </Field>
        </FormDialog>
      )}
    </section>
  );
}
