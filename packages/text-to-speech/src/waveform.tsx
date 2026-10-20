import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type {
  SpeechRuntime,
  SpeechTake,
  SpeechAudioAnalysis,
} from "@machdoch/speech";

import {
  parseAudioAnalysis,
  type Decibels,
} from "@machdoch/speech/audio-analysis";

type Selection = { from: number; to: number };

type AnalysisState =
  | { assetId: string; status: "loading" }
  | { assetId: string; status: "error" }
  | { assetId: string; status: "ready"; data: SpeechAudioAnalysis };

export interface WaveformProps {
  runtime: SpeechRuntime;
  take: SpeechTake;
  onSeek: (seconds: number) => void;
  onTrim?: (from: number, to: number) => void;
  selectedRange?: Selection;
}

function formatDb(value: Decibels, unit: string): string {
  return (value === "-inf" ? "−∞" : value.toFixed(2)) + " " + unit;
}

export function Waveform({
  runtime,
  take,
  onSeek,
  onTrim,
  selectedRange,
}: WaveformProps) {
  const assetId = take.asset.id;
  const [state, setState] = useState<AnalysisState>({
    assetId,
    status: "loading",
  });
  const [request, setRequest] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rangeId = useId();

  useEffect(() => {
    let active = true;
    setState({ assetId, status: "loading" });
    setCursor(0);
    setSelection(null);
    runtime
      .execute("analyzeAudio", {
        assetId,
        buckets: 1024,
        reuseCache: request === 0,
      })
      .then((value) => {
        const data = parseAudioAnalysis(value, take.asset);
        if (active) setState({ assetId, status: "ready", data });
      })
      .catch(() => {
        if (active) setState({ assetId, status: "error" });
      });
    return () => {
      active = false;
    };
  }, [runtime, assetId, request]);

  const analysis =
    state.assetId === assetId && state.status === "ready" ? state.data : null;
  const from = selectedRange?.from ?? selection?.from ?? 0;
  const to = selectedRange?.to ?? selection?.to ?? analysis?.duration ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis) return;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const ratio = window.devicePixelRatio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const color = getComputedStyle(canvas).color;
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      context.globalAlpha = 0.12;
      if (onTrim || selectedRange) {
        context.fillRect(
          (from / analysis.duration) * width,
          0,
          ((to - from) / analysis.duration) * width,
          height,
        );
      }
      context.globalAlpha = 0.2;
      context.fillRect(0, height / 2, width, 1);
      context.globalAlpha = 1;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 0; x < Math.ceil(width); x += 1) {
        const firstFrame = (x / width) * analysis.frames;
        const lastFrame = Math.min((x + 1) / width, 1) * analysis.frames;
        let min = Infinity;
        let max = -Infinity;
        const firstBucket = Math.max(
          0,
          Math.floor((firstFrame / analysis.frames) * analysis.peaks.length) -
            1,
        );
        for (
          let index = firstBucket;
          index < analysis.peaks.length;
          index += 1
        ) {
          const peak = analysis.peaks[index]!;
          if (peak.startFrame >= lastFrame) break;
          if (peak.endFrame <= firstFrame) continue;
          min = Math.min(min, peak.min);
          max = Math.max(max, peak.max);
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
        const amplitudeHeight = Math.max(0, height / 2 - 1 / ratio);
        const top =
          height / 2 - Math.max(-1, Math.min(1, max)) * amplitudeHeight;
        const bottom =
          height / 2 - Math.max(-1, Math.min(1, min)) * amplitudeHeight;
        context.moveTo(x + 0.5, top);
        context.lineTo(x + 0.5, Math.max(top + 1 / ratio, bottom));
      }
      context.stroke();
      context.globalAlpha = 0.7;
      context.fillRect(
        (cursor / analysis.duration) * Math.max(0, width - 1),
        0,
        1,
        height,
      );
      context.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [analysis, cursor, from, to, onTrim, selectedRange]);

  if (state.assetId !== assetId || state.status === "loading") {
    return (
      <div role="status" aria-live="polite">
        Analyzing audio…
      </div>
    );
  }
  if (state.status === "error" || !analysis) {
    return (
      <div role="alert">
        <p>Audio analysis failed. Try again.</p>
        <button type="button" onClick={() => setRequest((value) => value + 1)}>
          Retry analysis
        </button>
      </div>
    );
  }

  const seek = (seconds: number) => {
    const position = Math.max(0, Math.min(analysis.duration, seconds));
    setCursor(position);
    onSeek(position);
  };
  const seekPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0)
      seek(((event.clientX - bounds.left) / bounds.width) * analysis.duration);
  };
  const seekKeyboard = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? 1 : 0.1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = cursor + step;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = cursor - step;
        break;
      case "PageUp":
        next = cursor + 10;
        break;
      case "PageDown":
        next = cursor - 10;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = analysis.duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    seek(next);
  };
  const trim = (edge: "from" | "to", seconds: number) => {
    const frame = 1 / analysis.sampleRate;
    const snapped =
      Math.round(seconds * analysis.sampleRate) / analysis.sampleRate;
    const next =
      edge === "from"
        ? { from: Math.max(0, Math.min(to - frame, snapped)), to }
        : {
            from,
            to: Math.min(analysis.duration, Math.max(from + frame, snapped)),
          };
    setSelection(next);
    onTrim?.(next.from, next.to);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        role="slider"
        tabIndex={0}
        aria-label="Audio position"
        aria-valuemin={0}
        aria-valuemax={analysis.duration}
        aria-valuenow={cursor}
        aria-valuetext={cursor.toFixed(3) + " seconds"}
        aria-orientation="horizontal"
        style={{
          display: "block",
          width: "100%",
          height: 160,
          touchAction: "none",
          cursor: "crosshair",
        }}
        onKeyDown={seekKeyboard}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          seekPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            seekPointer(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            seekPointer(event);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      />
      {onTrim && (
        <div>
          <label htmlFor={rangeId + "-from"}>Trim start</label>
          <input
            id={rangeId + "-from"}
            type="range"
            min={0}
            max={Math.max(0, to - 1 / analysis.sampleRate)}
            step={1 / analysis.sampleRate}
            value={from}
            aria-valuetext={from.toFixed(3) + " seconds"}
            onChange={(event) => trim("from", Number(event.target.value))}
          />
          <output htmlFor={rangeId + "-from"}>{from.toFixed(3)} s</output>
          <label htmlFor={rangeId + "-to"}>Trim end</label>
          <input
            id={rangeId + "-to"}
            type="range"
            min={from + 1 / analysis.sampleRate}
            max={analysis.duration}
            step={1 / analysis.sampleRate}
            value={to}
            aria-valuetext={to.toFixed(3) + " seconds"}
            onChange={(event) => trim("to", Number(event.target.value))}
          />
          <output htmlFor={rangeId + "-to"}>{to.toFixed(3)} s</output>
        </div>
      )}
      <dl>
        <dt>Duration</dt>
        <dd>{analysis.duration.toFixed(3)} s</dd>
        <dt>Sample rate</dt>
        <dd>{analysis.sampleRate.toLocaleString()} Hz</dd>
        <dt>Channels</dt>
        <dd>{analysis.channels}</dd>
        <dt>Sample peak</dt>
        <dd>{formatDb(analysis.samplePeakDbfs, "dBFS")}</dd>
        <dt>RMS</dt>
        <dd>{formatDb(analysis.rmsDbfs, "dBFS")}</dd>
        <dt>Integrated loudness</dt>
        <dd>{formatDb(analysis.loudness.integratedLufs, "LUFS")}</dd>
        <dt>True peak</dt>
        <dd>{formatDb(analysis.loudness.truePeakDbtp, "dBTP")}</dd>
        <dt>Clipped samples</dt>
        <dd>{analysis.clippedSamples.toLocaleString()}</dd>
        <dt>Zero samples</dt>
        <dd>
          {analysis.zeroSamples.toLocaleString()} /{" "}
          {analysis.sampleCount.toLocaleString()}
        </dd>
      </dl>
    </div>
  );
}
