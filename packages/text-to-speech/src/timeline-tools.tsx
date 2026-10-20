import type { SpeechTake, SpeechTimelineClip } from "@machdoch/speech";
import { Field, formNumber } from "./controls.tsx";
import {
  crossfadeTimelineClips,
  replaceTimelineTake,
  splitTimelineClip,
} from "./timeline.ts";

export function TimelineTools({
  clips,
  takes,
  change,
  insertSilence,
  report,
}: {
  clips: SpeechTimelineClip[];
  takes: SpeechTake[];
  change(clips: SpeechTimelineClip[]): void;
  insertSilence(position: number, duration: number): void;
  report(error: unknown): void;
}) {
  return (
    <details className="tts-stack">
      <summary>Edit timeline</summary>
      <form
        className="tts-row"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const data = new FormData(event.currentTarget);
            insertSilence(
              formNumber(data, "position"),
              formNumber(data, "duration"),
            );
          } catch (error) {
            report(error);
          }
        }}
      >
        <Field label="Silence position (s)">
          <input
            type="number"
            name="position"
            min={0}
            step="any"
            defaultValue={0}
            required
          />
        </Field>
        <Field label="Silence duration (s)">
          <input
            type="number"
            name="duration"
            min={0.001}
            step="any"
            defaultValue={1}
            required
          />
        </Field>
        <button>Insert silence</button>
      </form>
      {clips.map((clip, index) => (
        <fieldset className="tts-stack" key={JSON.stringify(clip)}>
          <legend>Clip {index + 1}</legend>
          <form
            className="tts-row"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const split = splitTimelineClip(
                  clip,
                  formNumber(new FormData(event.currentTarget), "position"),
                  crypto.randomUUID(),
                );
                change(
                  clips.flatMap((item) =>
                    item.id === clip.id ? split : [item],
                  ),
                );
              } catch (error) {
                report(error);
              }
            }}
          >
            <Field label={`Split clip ${index + 1} at (s)`}>
              <input
                type="number"
                name="position"
                min={clip.start}
                max={clip.start + clip.out - clip.in}
                step="any"
                defaultValue={clip.start + (clip.out - clip.in) / 2}
                required
              />
            </Field>
            <button>Split clip {index + 1}</button>
          </form>
          <form
            className="tts-row"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const data = new FormData(event.currentTarget);
                const take = takes.find(
                  (item) => item.id === data.get("takeId"),
                );
                if (!take) throw new Error("Choose a replacement take.");
                const updated = replaceTimelineTake(
                  clip,
                  take.id,
                  take.asset.duration,
                );
                change(
                  clips.map((item) => (item.id === clip.id ? updated : item)),
                );
              } catch (error) {
                report(error);
              }
            }}
          >
            <Field label={`Replacement for clip ${index + 1}`}>
              <select name="takeId" defaultValue="" required>
                <option value="">Choose take</option>
                {takes
                  .filter((take) => take.id !== clip.takeId)
                  .map((take, takeIndex) => (
                    <option value={take.id} key={take.id}>
                      {takeIndex + 1} · {take.spokenText.slice(0, 60)}
                    </option>
                  ))}
              </select>
            </Field>
            <button>Replace take in clip {index + 1}</button>
          </form>
          <form
            className="tts-row"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const data = new FormData(event.currentTarget);
                const next = clips.find(
                  (item) => item.id === data.get("nextId"),
                );
                if (!next)
                  throw new Error("Choose the next clip to crossfade.");
                const [first, second] = crossfadeTimelineClips(
                  clip,
                  next,
                  formNumber(data, "duration"),
                );
                change(
                  clips.map((item) =>
                    item.id === clip.id
                      ? first
                      : item.id === next.id
                        ? second
                        : item,
                  ),
                );
              } catch (error) {
                report(error);
              }
            }}
          >
            <Field label={`Crossfade clip ${index + 1} into`}>
              <select name="nextId" defaultValue="" required>
                <option value="">Choose clip</option>
                {clips.flatMap((item, nextIndex) =>
                  item.id !== clip.id &&
                  item.track === clip.track &&
                  item.start >= clip.start
                    ? [
                        <option value={item.id} key={item.id}>
                          Clip {nextIndex + 1}
                        </option>,
                      ]
                    : [],
                )}
              </select>
            </Field>
            <Field label={`Crossfade duration for clip ${index + 1} (s)`}>
              <input
                type="number"
                name="duration"
                min={0.001}
                step="any"
                defaultValue={0.2}
                required
              />
            </Field>
            <button>Crossfade clip {index + 1}</button>
          </form>
        </fieldset>
      ))}
    </details>
  );
}
