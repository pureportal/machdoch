import { useEffect, useRef, useState } from "react";
import type {
  CompiledSpeechSegment,
  SpeechProject,
  SpeechRuntime,
  SpeechTake,
} from "@machdoch/speech";
import {
  DEFAULT_PRODUCTION_CHECKS,
  speechProductionSelections,
  speechTakeProductionChecks,
  type SpeechProductionFinding,
} from "@machdoch/speech/production-checks";
import { parseAudioAnalysis } from "@machdoch/speech/audio-analysis";
import { Field, formNumber, type Run } from "./controls.tsx";

export function ProductionChecks({
  project,
  takes,
  segments,
  runtime,
  ready,
  busy,
  run,
  onSeek,
}: {
  project: SpeechProject;
  takes: SpeechTake[];
  segments: CompiledSpeechSegment[];
  runtime: SpeechRuntime;
  ready: boolean;
  busy: boolean;
  run: Run;
  onSeek(take: SpeechTake, seconds: number): Promise<void>;
}) {
  const [result, setResult] = useState<{
    findings: SpeechProductionFinding[];
    checked: number;
    total: number;
    truncated: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [loudness, setLoudness] = useState(false);
  const [duration, setDuration] = useState(false);
  const generation = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const current = useRef(project);
  current.current = project;
  useEffect(() => {
    generation.current++;
    setResult(null);
    setFailed(false);
    setChecking(false);
    return () => {
      generation.current++;
    };
  }, [project, segments.map((segment) => segment.id).join("\0")]);
  if (!segments.length) return null;
  const check = (reuseCache: boolean) =>
    run(async () => {
      if (!ready || !form.current)
        throw new Error(
          "Wait for current script analysis before checking production.",
        );
      const data = new FormData(form.current);
      const policy = {
        ...DEFAULT_PRODUCTION_CHECKS,
        silencePercent: formNumber(data, "silence"),
        truePeakDbtp: formNumber(data, "peak"),
        targetLufs: loudness ? formNumber(data, "lufs") : null,
        loudnessTolerance: loudness ? formNumber(data, "lufsTolerance") : 1,
        durationTolerancePercent: duration
          ? formNumber(data, "durationTolerance")
          : null,
      };
      const token = ++generation.current;
      const revision = current.current;
      const selected = speechProductionSelections(project, takes, segments);
      const findings = selected.findings.slice(0, 100);
      let truncated = selected.truncated;
      let checked = 0;
      setChecking(true);
      setFailed(false);
      try {
        for (const item of selected.selected) {
          if (token !== generation.current || revision !== current.current)
            return;
          const analysis = parseAudioAnalysis(
            await runtime.execute("analyzeAudio", {
              assetId: item.take.asset.id,
              buckets: 512,
              reuseCache,
            }),
            item.take.asset,
          );
          if (token !== generation.current || revision !== current.current)
            return;
          for (const finding of speechTakeProductionChecks(
            item.segment,
            item.take,
            analysis,
            policy,
          )) {
            if (findings.length < 100) findings.push(finding);
            else truncated = true;
          }
          checked++;
          setResult({
            findings: [...findings],
            checked,
            total: selected.selected.length,
            truncated,
          });
        }
        if (token === generation.current)
          setResult({
            findings,
            checked,
            total: selected.selected.length,
            truncated,
          });
      } catch (error) {
        if (token !== generation.current || revision !== current.current)
          return;
        setFailed(true);
        throw error;
      } finally {
        if (token === generation.current) setChecking(false);
      }
    });
  return (
    <details className="tts-stack">
      <summary>Production checks</summary>
      <form
        ref={form}
        className="tts-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void check(true);
        }}
      >
        <Field label="Silence limit (%)">
          <input
            name="silence"
            type="number"
            min={0}
            max={100}
            step="any"
            defaultValue={100}
            required
          />
        </Field>
        <Field label="True-peak limit (dBTP)">
          <input
            name="peak"
            type="number"
            min={-12}
            max={0}
            step="any"
            defaultValue={0}
            required
          />
        </Field>
        <label className="tts-check">
          <input
            type="checkbox"
            checked={loudness}
            onChange={(event) => setLoudness(event.target.checked)}
          />
          Check target loudness
        </label>
        {loudness && (
          <>
            <Field label="Target loudness (LUFS)">
              <input
                name="lufs"
                type="number"
                min={-70}
                max={0}
                step="any"
                defaultValue={-16}
                required
              />
            </Field>
            <Field label="Loudness tolerance (LU)">
              <input
                name="lufsTolerance"
                type="number"
                min={0}
                step="any"
                defaultValue={1}
                required
              />
            </Field>
          </>
        )}
        <label className="tts-check">
          <input
            type="checkbox"
            checked={duration}
            onChange={(event) => setDuration(event.target.checked)}
          />
          Compare estimated duration
        </label>
        {duration && (
          <Field label="Duration tolerance (%)">
            <input
              name="durationTolerance"
              type="number"
              min={0}
              step="any"
              defaultValue={50}
              required
            />
          </Field>
        )}
        <button disabled={busy || !ready}>Check production</button>
        {failed && (
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              if (form.current?.reportValidity()) void check(false);
            }}
          >
            Rebuild analyses
          </button>
        )}
        {checking && (
          <button
            type="button"
            onClick={() => {
              generation.current++;
              setChecking(false);
            }}
          >
            Stop after current take
          </button>
        )}
      </form>
      {result && (
        <>
          <output aria-live="polite">
            Checked {result.checked} of {result.total} selected takes.
          </output>
          <ul>
            {result.findings.map((finding, index) => {
              const take = takes.find((take) => take.id === finding.takeId);
              const segmentIndex = segments.findIndex(
                (segment) => segment.id === finding.segmentId,
              );
              return (
                <li key={`${finding.code}:${index}`}>
                  <span>
                    Segment {segmentIndex + 1}: {finding.message}
                  </span>
                  {take && (
                    <button
                      onClick={() =>
                        void run(() => onSeek(take, finding.position ?? 0))
                      }
                    >
                      Listen
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {result.truncated && (
            <p>
              Fix these issues and check again to review the remaining findings.
            </p>
          )}
        </>
      )}
    </details>
  );
}
