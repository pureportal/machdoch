import { useEffect, useState } from "react";
import type {
  SpeechBackgroundClip,
  SpeechDucking,
  SpeechProject,
  SpeechRuntime,
} from "@machdoch/speech";
import { Field, formNumber, type Run } from "./controls.tsx";
import { splitTimelineClip, crossfadeTimelineClips } from "./timeline.ts";

export function BackgroundTracks({
  project,
  runtime,
  change,
  run,
  busy,
  audition,
  assetUrl,
  report,
}: {
  project: SpeechProject;
  runtime: SpeechRuntime;
  change(
    update: (tracks: SpeechBackgroundClip[]) => SpeechBackgroundClip[],
  ): void;
  run: Run;
  busy: boolean;
  audition(id: string, url: string): Promise<void>;
  assetUrl(path: string): string;
  report(error: unknown): void;
}) {
  const tracks = project.backgroundTracks ?? [];
  const update = (clips: SpeechBackgroundClip[]) => change(() => clips);
  return (
    <section className="tts-stack">
      <h2>Background audio</h2>
      <form
        className="tts-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void run(async () => {
            const imported = await runtime.execute("importAudioTrack", {
              path: String(data.get("path")).trim(),
              rightsEvidence: String(data.get("rights")).trim(),
            });
            const path = String(data.get("path")).trim();
            const clip: SpeechBackgroundClip = {
              id: crypto.randomUUID(),
              name:
                String(data.get("name")).trim() || path.split(/[\\/]/u).at(-1)!,
              assetId: imported.asset.id,
              role: String(data.get("role")) as "music" | "sfx",
              ducking: null,
              start: 0,
              in: 0,
              out: imported.asset.duration,
              gain: 0.25,
              fadeIn: 0,
              fadeOut: 0,
              track: 1,
            };
            change((current) => [...current, clip]);
          });
        }}
      >
        <Field
          label={
            runtime.transport === "remote"
              ? "File path on device"
              : "Audio file path"
          }
        >
          <input name="path" required />
        </Field>
        <Field label="Track name">
          <input name="name" />
        </Field>
        <Field label="Audio role">
          <select name="role">
            <option value="music">Music</option>
            <option value="sfx">Sound effects</option>
          </select>
        </Field>
        <Field label="Audio permission">
          <textarea name="rights" required />
        </Field>
        <button disabled={busy}>Import audio track</button>
      </form>
      {tracks.map((clip, index) => (
        <BackgroundClip
          key={clip.id}
          clip={clip}
          index={index}
          tracks={tracks}
          update={update}
          report={report}
          busy={busy}
          preview={() =>
            run(async () => {
              const asset = await runtime.execute("asset", {
                id: clip.assetId,
              });
              await audition(clip.id, assetUrl(asset.path));
            })
          }
        />
      ))}
    </section>
  );
}

function BackgroundClip({
  clip,
  index,
  tracks,
  update,
  report,
  busy,
  preview,
}: {
  clip: SpeechBackgroundClip;
  index: number;
  tracks: SpeechBackgroundClip[];
  update(tracks: SpeechBackgroundClip[]): void;
  report(error: unknown): void;
  busy: boolean;
  preview(): Promise<void>;
}) {
  const [duck, setDuck] = useState(clip.ducking !== null);
  const hasDucking = clip.ducking !== null;
  useEffect(() => setDuck(hasDucking), [hasDucking]);
  const replace = (updated: SpeechBackgroundClip) =>
    update(tracks.map((item) => (item.id === clip.id ? updated : item)));
  const fields = [
    { name: "start", label: "Start (s)" },
    { name: "in", label: "Trim in (s)" },
    { name: "out", label: "Trim out (s)" },
    { name: "gain", label: "Gain (×)" },
    { name: "fadeIn", label: "Fade in (s)" },
    { name: "fadeOut", label: "Fade out (s)" },
    { name: "track", label: "Track" },
  ] as const;
  const ducking: SpeechDucking = clip.ducking ?? {
    thresholdDbfs: -36,
    reductionDb: -12,
    attackMs: 20,
    releaseMs: 250,
  };
  return (
    <article className="tts-stack" aria-label={`Background track ${index + 1}`}>
      <h3>{clip.name}</h3>
      <div className="tts-row">
        <button type="button" disabled={busy} onClick={() => void preview()}>
          Preview source
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => update(tracks.filter((item) => item.id !== clip.id))}
        >
          Remove track
        </button>
      </div>
      <form
        key={JSON.stringify(clip)}
        className="tts-grid"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const data = new FormData(event.currentTarget);
            const updated = { ...clip };
            updated.name = String(data.get("name")).trim();
            updated.role = String(data.get("role")) as "music" | "sfx";
            for (const field of fields)
              updated[field.name] = formNumber(data, field.name);
            if (
              !updated.name ||
              updated.out <= updated.in ||
              updated.fadeIn + updated.fadeOut > updated.out - updated.in ||
              !Number.isInteger(updated.track)
            )
              throw new Error(
                "Enter a track name, a valid trim and fades, and a whole track number.",
              );
            updated.ducking = duck
              ? {
                  thresholdDbfs: formNumber(data, "thresholdDbfs"),
                  reductionDb: formNumber(data, "reductionDb"),
                  attackMs: formNumber(data, "attackMs"),
                  releaseMs: formNumber(data, "releaseMs"),
                }
              : null;
            replace(updated);
          } catch (error) {
            report(error);
          }
        }}
      >
        <Field label={`Name for background track ${index + 1}`}>
          <input name="name" defaultValue={clip.name} required />
        </Field>
        <Field label={`Role for background track ${index + 1}`}>
          <select name="role" defaultValue={clip.role}>
            <option value="music">Music</option>
            <option value="sfx">Sound effects</option>
          </select>
        </Field>
        {fields.map((field) => (
          <Field
            key={field.name}
            label={`${field.label} for background track ${index + 1}`}
          >
            <input
              name={field.name}
              type="number"
              min={0}
              max={
                field.name === "gain"
                  ? 16
                  : field.name === "track"
                    ? 1023
                    : undefined
              }
              step={field.name === "track" ? 1 : "any"}
              defaultValue={clip[field.name]}
              required
            />
          </Field>
        ))}
        <label className="tts-check">
          <input
            type="checkbox"
            checked={duck}
            onChange={(event) => setDuck(event.target.checked)}
          />
          Duck under speech
        </label>
        {duck && (
          <fieldset className="tts-grid">
            <legend>Voice ducking</legend>
            {(
              [
                {
                  name: "thresholdDbfs",
                  label: "Threshold (dBFS)",
                  min: -80,
                  max: 0,
                },
                {
                  name: "reductionDb",
                  label: "Reduction (dB)",
                  min: -60,
                  max: 0,
                },
                { name: "attackMs", label: "Attack (ms)", min: 1, max: 2000 },
                {
                  name: "releaseMs",
                  label: "Release (ms)",
                  min: 1,
                  max: 10000,
                },
              ] as const
            ).map((field) => (
              <Field
                key={field.name}
                label={`${field.label} for background track ${index + 1}`}
              >
                <input
                  type="number"
                  name={field.name}
                  min={field.min}
                  max={field.max}
                  step="any"
                  defaultValue={ducking[field.name]}
                  required
                />
              </Field>
            ))}
          </fieldset>
        )}
        <button disabled={busy}>Apply background track {index + 1}</button>
      </form>
      <details>
        <summary>Edit track</summary>
        <form
          className="tts-row"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const [before, after] = splitTimelineClip(
                clip,
                formNumber(new FormData(event.currentTarget), "position"),
                crypto.randomUUID(),
              );
              update(
                tracks.flatMap((item) =>
                  item.id === clip.id ? [before, after] : [item],
                ),
              );
            } catch (error) {
              report(error);
            }
          }}
        >
          <Field label={`Split background track ${index + 1} at (s)`}>
            <input
              name="position"
              type="number"
              min={clip.start}
              max={clip.start + clip.out - clip.in}
              step="any"
              defaultValue={clip.start + (clip.out - clip.in) / 2}
              required
            />
          </Field>
          <button>Split background track {index + 1}</button>
        </form>
        <form
          className="tts-row"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const data = new FormData(event.currentTarget);
              const next = tracks.find((item) => item.id === data.get("next"));
              if (!next) throw new Error("Choose the next background clip.");
              const [before, after] = crossfadeTimelineClips(
                clip,
                next,
                formNumber(data, "duration"),
              );
              update(
                tracks.map((item) =>
                  item.id === clip.id
                    ? before
                    : item.id === next.id
                      ? after
                      : item,
                ),
              );
            } catch (error) {
              report(error);
            }
          }}
        >
          <Field label={`Crossfade background track ${index + 1} into`}>
            <select name="next" required defaultValue="">
              <option value="">Choose clip</option>
              {tracks.flatMap((item, nextIndex) =>
                item.id !== clip.id &&
                item.track === clip.track &&
                item.start >= clip.start
                  ? [
                      <option value={item.id} key={item.id}>
                        Background {nextIndex + 1} · {item.name}
                      </option>,
                    ]
                  : [],
              )}
            </select>
          </Field>
          <Field label={`Background crossfade duration ${index + 1} (s)`}>
            <input
              name="duration"
              type="number"
              min={0.001}
              step="any"
              defaultValue={0.2}
              required
            />
          </Field>
          <button>Crossfade background track {index + 1}</button>
        </form>
      </details>
    </article>
  );
}
