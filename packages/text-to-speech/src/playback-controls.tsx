import { useEffect, useState } from "react";
import { speechPlayback, type PlaybackState } from "@machdoch/speech";
import { Field, formNumber } from "./controls.tsx";

export function PlaybackControls({
  state,
  report,
}: {
  state: PlaybackState;
  report(error: unknown): void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!state.outputDeviceSupported || !navigator.mediaDevices) return;
    let disposed = false;
    const read = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((items) => {
          if (!disposed)
            setDevices(items.filter((device) => device.kind === "audiooutput"));
        })
        .catch(report);
    };
    read();
    navigator.mediaDevices.addEventListener("devicechange", read);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", read);
    };
  }, [state.outputDeviceSupported, report]);
  return (
    <div className="tts-row">
      <Field label="Speed">
        <input
          type="number"
          min={0.1}
          max={4}
          step="any"
          value={state.rate ?? 1}
          onChange={(event) => {
            try {
              speechPlayback.setRate(event.target.valueAsNumber);
            } catch (error) {
              report(error);
            }
          }}
        />
      </Field>
      <Field label="Volume">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.volume ?? 1}
          onChange={(event) =>
            speechPlayback.setVolume(event.target.valueAsNumber)
          }
        />
      </Field>
      {state.outputDeviceSupported && (
        <Field label="Audio output">
          <select
            value={state.outputDeviceId ?? ""}
            onChange={(event) =>
              void speechPlayback
                .setOutputDevice(event.target.value)
                .catch(report)
            }
          >
            <option value="">System default</option>
            {devices
              .filter((device) => device.deviceId !== "default")
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Audio output ${index + 1}`}
                </option>
              ))}
          </select>
        </Field>
      )}
      {state.loopAvailable && (
        <form
          key={state.itemId}
          className="tts-row"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const data = new FormData(event.currentTarget);
              speechPlayback.setLoop({
                start: formNumber(data, "start"),
                end: formNumber(data, "end"),
              });
            } catch (error) {
              report(error);
            }
          }}
        >
          <Field label="Loop start (s)">
            <input
              name="start"
              type="number"
              min={0}
              max={state.duration ?? undefined}
              step="any"
              defaultValue={0}
              required
            />
          </Field>
          <Field label="Loop end (s)">
            <input
              name="end"
              type="number"
              min={0}
              max={state.duration ?? undefined}
              step="any"
              defaultValue={state.duration ?? undefined}
              required
            />
          </Field>
          <button>Loop selection</button>
          {state.loop && (
            <button type="button" onClick={() => speechPlayback.setLoop(null)}>
              Clear loop
            </button>
          )}
        </form>
      )}
    </div>
  );
}
