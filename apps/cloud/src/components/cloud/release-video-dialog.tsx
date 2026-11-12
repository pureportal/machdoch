"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  videoFormats,
  visualFormats,
  type VideoCard,
  type VideoInput,
} from "@/lib/cloud-release-media-contract";
import { createCommandSender } from "./api-client";
import { mediaUrl } from "./release-display";
import type { StudioContext } from "./release-studio";

function CardFields({
  label,
  card,
  onChange,
}: {
  label: string;
  card: VideoCard;
  onChange: (card: VideoCard) => void;
}) {
  return (
    <fieldset className="cloud-release-card-fields">
      <Label className="cloud-automation-check">
        <input
          type="checkbox"
          checked={card.enabled}
          onChange={(event) =>
            onChange({ ...card, enabled: event.target.checked })
          }
        />
        {label}
      </Label>
      {card.enabled && (
        <div className="cloud-automation-row">
          <Input
            aria-label={`${label} headline`}
            value={card.headline}
            maxLength={140}
            onChange={(event) =>
              onChange({ ...card, headline: event.target.value })
            }
          />
          <Input
            aria-label={`${label} subline`}
            value={card.subline}
            maxLength={240}
            onChange={(event) =>
              onChange({ ...card, subline: event.target.value })
            }
          />
          <Input
            aria-label={`${label} seconds`}
            type="number"
            min={1}
            max={8}
            step={0.5}
            className="cloud-automation-limit"
            value={card.seconds}
            onChange={(event) =>
              onChange({ ...card, seconds: Number(event.target.value) || 1 })
            }
          />
        </div>
      )}
    </fieldset>
  );
}

export function ReleaseVideoDialog({
  context,
  recipe,
  onClose,
}: {
  context: StudioContext;
  recipe?: VideoInput;
  onClose: () => void;
}) {
  const { product, release, media } = context;
  const sender = useRef(createCommandSender());
  const sources = media.filter((entry) => entry.role !== "video");
  const [input, setInput] = useState<VideoInput>(() =>
    recipe
      ? {
          ...recipe,
          clips: recipe.clips.filter((clip) =>
            sources.some((entry) => entry.id === clip.mediaId),
          ),
        }
      : {
          name: `${product.name} ${release.version}`,
          format: "wide",
          clips: sources
            .filter(
              (entry) =>
                entry.role === "recording" || entry.role === "screenshot",
            )
            .slice(0, 6)
            .map((entry) => ({
              mediaId: entry.id,
              seconds: entry.kind === "video" ? 15 : 4,
              caption: entry.caption.slice(0, 120),
            })),
          intro: {
            enabled: true,
            headline: `${product.name} ${release.version}`,
            subline: release.name,
            seconds: product.video.introSeconds || 2.5,
          },
          outro: {
            enabled: true,
            headline: product.callToAction || "Try it today",
            subline: product.website?.replace(/^https:\/\//, "") ?? "",
            seconds: product.video.outroSeconds || 3,
          },
        },
  );
  const update = (patch: Partial<VideoInput>) =>
    setInput((current) => ({ ...current, ...patch }));
  const setClips = (clips: VideoInput["clips"]) => update({ clips });
  const available = sources.filter(
    (entry) => !input.clips.some((clip) => clip.mediaId === entry.id),
  );
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={recipe ? "Edit video" : "Compose video"}
      submitLabel="Render video"
      submitDisabled={!input.clips.length || !input.name.trim()}
      onSubmit={async () => {
        await sender.current(`releases/${release.id}/videos`, input);
        await context.refresh();
      }}
    >
      <div className="cloud-automation-editor">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="video-name">
            <Input
              id="video-name"
              value={input.name}
              maxLength={120}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="Format" htmlFor="video-format">
            <Select
              id="video-format"
              value={input.format}
              onChange={(event) =>
                update({ format: event.target.value as VideoInput["format"] })
              }
            >
              {videoFormats.map((format) => (
                <option key={format} value={format}>
                  {visualFormats[format].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <CardFields
          label="Intro"
          card={input.intro}
          onChange={(intro) => update({ intro })}
        />
        <section className="cloud-automation-section" aria-label="Clips">
          <h3>Clips</h3>
          {input.clips.map((clip, index) => {
            const entry = media.find((item) => item.id === clip.mediaId);
            return (
              <div key={clip.mediaId} className="cloud-release-clip">
                <span className="cloud-release-clip-thumb">
                  {entry?.kind === "video" ? (
                    <video src={`${mediaUrl(clip.mediaId)}#t=1`} muted />
                  ) : (
                    <img src={mediaUrl(clip.mediaId)} alt="" />
                  )}
                </span>
                <Input
                  aria-label={`Caption for clip ${index + 1}`}
                  placeholder="Caption"
                  value={clip.caption}
                  maxLength={120}
                  onChange={(event) =>
                    setClips(
                      input.clips.map((item, position) =>
                        position === index
                          ? { ...item, caption: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Seconds for clip ${index + 1}`}
                  type="number"
                  min={1}
                  max={20}
                  className="cloud-automation-limit"
                  value={clip.seconds}
                  onChange={(event) =>
                    setClips(
                      input.clips.map((item, position) =>
                        position === index
                          ? {
                              ...item,
                              seconds: Number(event.target.value) || 1,
                            }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => {
                    const clips = [...input.clips];
                    [clips[index - 1], clips[index]] = [
                      clips[index]!,
                      clips[index - 1]!,
                    ];
                    setClips(clips);
                  }}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  disabled={index === input.clips.length - 1}
                  onClick={() => {
                    const clips = [...input.clips];
                    [clips[index + 1], clips[index]] = [
                      clips[index]!,
                      clips[index + 1]!,
                    ];
                    setClips(clips);
                  }}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove clip ${index + 1}`}
                  onClick={() =>
                    setClips(
                      input.clips.filter((_, position) => position !== index),
                    )
                  }
                >
                  <X />
                </Button>
              </div>
            );
          })}
          {available.length > 0 && input.clips.length < 12 && (
            <div className="cloud-release-picker" aria-label="Add clip">
              {available.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-label={`Add ${entry.caption || entry.name}`}
                  onClick={() =>
                    setClips([
                      ...input.clips,
                      {
                        mediaId: entry.id,
                        seconds: entry.kind === "video" ? 15 : 4,
                        caption: entry.caption.slice(0, 120),
                      },
                    ])
                  }
                >
                  {entry.kind === "video" ? (
                    <video src={`${mediaUrl(entry.id)}#t=1`} muted />
                  ) : (
                    <img src={mediaUrl(entry.id)} alt="" />
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
        <CardFields
          label="Outro"
          card={input.outro}
          onChange={(outro) => update({ outro })}
        />
      </div>
    </FormDialog>
  );
}
