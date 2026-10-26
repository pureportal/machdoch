"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Plus } from "lucide-react";
import { estimateScaleSchema, type CloudTeam } from "@/lib/cloud-contract";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import { createCommandSender } from "./api-client";

export function EstimateScaleEditor({ team }: { team: CloudTeam }) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState(
    team.estimateScale.map((card) => ({
      label: card.label,
      points: card.points === null ? "" : String(card.points),
    })),
  );
  const sender = useRef(createCommandSender());
  const router = useRouter();
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setCards(
            team.estimateScale.map((card) => ({
              label: card.label,
              points: card.points === null ? "" : String(card.points),
            })),
          );
          setOpen(true);
        }}
      >
        Estimate scale
      </Button>
      <FormDialog
        title={`${team.name} estimate scale`}
        submitLabel="Save scale"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) sender.current = createCommandSender();
        }}
        onSubmit={async () => {
          const scale = estimateScaleSchema.safeParse(
            cards.map((card) => ({
              label: card.label,
              points: card.points === "" ? null : Number(card.points),
            })),
          );
          if (!scale.success) throw new Error(scale.error.issues[0]!.message);
          await sender.current(
            `teams/${team.id}/scale`,
            { revision: team.revision, estimateScale: scale.data },
            "PATCH",
          );
          router.refresh();
        }}
      >
        {cards.map((card, index) => (
          <div className="cloud-scale-row" key={index}>
            <Field label="Card" htmlFor={`card-${index}`}>
              <Input
                id={`card-${index}`}
                value={card.label}
                maxLength={16}
                required
                onChange={(event) =>
                  setCards(
                    cards.map((entry, i) =>
                      i === index
                        ? { ...entry, label: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
            </Field>
            <Field label="Points" htmlFor={`points-${index}`}>
              <Input
                id={`points-${index}`}
                type="number"
                min={0}
                max={100000}
                step="any"
                value={card.points}
                onChange={(event) =>
                  setCards(
                    cards.map((entry, i) =>
                      i === index
                        ? { ...entry, points: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              type="button"
              aria-label={`Remove card ${index + 1}`}
              disabled={cards.length <= 2}
              onClick={() => setCards(cards.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          type="button"
          disabled={cards.length >= 30}
          onClick={() => setCards([...cards, { label: "", points: "" }])}
        >
          <Plus />
          Add card
        </Button>
      </FormDialog>
    </>
  );
}
