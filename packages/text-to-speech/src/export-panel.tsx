import { useEffect, useState } from "react";
import { Download, Play, Save } from "lucide-react";
import {
  DEFAULT_SPEECH_EXPORT,
  orderedProductionTakes,
  validateSpeechExportPreset,
  type SpeechExportInput,
  type SpeechExportPreset,
  type SpeechProject,
  type SpeechTake,
  type SpeechRuntime,
  type SpeechOperations,
} from "@machdoch/speech";
import { Field, FORMATS, type Run } from "./controls.tsx";
import {BatchExports} from "./batch-exports.tsx";
import {ArchivePermissions,useArchivePermissions} from "./archive-permissions.tsx";
import type {CompiledSpeech} from "@machdoch/speech";

type Scope = "production" | "selected" | "clip";

const EXPORT_PRESETS = [
  { id: "master", label: "Lossless master", settings: DEFAULT_SPEECH_EXPORT },
  { id: "podcast", label: "Podcast", settings: { format: "mp3", sampleRate: 48000, channels: 2, bitrate: 192000, loudnessLufs: -16, truePeakDb: -1 } },
  { id: "audiobook", label: "Audiobook", settings: { format: "m4b", sampleRate: 44100, channels: 1, bitrate: 96000, loudnessLufs: -20, truePeakDb: -3 } },
] satisfies Array<{ id: string; label: string; settings: SpeechExportPreset }>;

export function ExportPanel({
  project,
  takes,
  segments,
  analysisReady,
  runtime,
  save,
  changeSettings,
  run,
  busy,
  assetUrl,
  audition,
  compiled,
}: {
  project: SpeechProject;
  takes: SpeechTake[];
  segments: string[];
  runtime: SpeechRuntime;
  save(): Promise<SpeechProject | null>;
  changeSettings(settings: SpeechExportPreset): void;
  run: Run;
  busy: boolean;
  assetUrl(path: string): string;
  audition(id: string, url: string): Promise<void>;
  analysisReady: boolean;
  compiled:CompiledSpeech;
}) {
  const defaults = (): SpeechExportPreset =>
    project.exportSettings ?? { ...DEFAULT_SPEECH_EXPORT };
  const [settings, setSettings] = useState(defaults);
  const archivePermissions=useArchivePermissions(runtime,project.id);
  const [scope, setScope] = useState<Scope>("production");
  const [clipId, setClipId] = useState("");
  const [range, setRange] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(1);
  const [result, setResult] = useState<
    SpeechOperations["export"]["output"] | null
  >(null);
  const audio = ["wav", "mp3", "opus", "flac", "m4b"].includes(settings.format);
  const compressed = ["mp3", "opus", "m4b"].includes(settings.format);
  const preset = EXPORT_PRESETS.find(preset => Object.entries(preset.settings).every(([key, value]) => settings[key as keyof SpeechExportPreset] === value));
  const hasAudio = scope === "clip" ? takes.some(take => take.id === clipId) : scope === "production" && (project.timeline.length > 0 || !!project.backgroundTracks?.length) || takes.some(take => project.selectedTakes[take.segmentId] === take.id);
  useEffect(() => {
    setSettings(defaults());
    setResult(null);
  }, [project.id, JSON.stringify(project.exportSettings)]);
  useEffect(() => {
    setScope("production");
    setRange(false);
    setClipId("");
  }, [project.id]);
  function input(
    stored: SpeechProject,
    forAudio = false,
  ): Omit<SpeechExportInput, "outputPath" | "overwrite"> {
    validateSpeechExportPreset(settings);
    if (settings.format === "archive" && !forAudio) {
      if (range)
        throw new Error(
          "Clear the export range before creating a portable project archive.",
        );
      return {
        ...settings,
        projectId: stored.id,
        revisionId: stored.revisionId,
        takeIds: [],
      };
    }
    if (scope !== "clip" && !analysisReady)
      throw new Error("Wait for script analysis before producing the project.");
    let takeIds: string[];
    if (scope === "clip") {
      if (!takes.some((take) => take.id === clipId))
        throw new Error("Choose a rendered clip.");
      takeIds = [clipId];
    } else if (
      scope === "production" &&
      (stored.timeline.length || (stored.backgroundTracks?.length ?? 0) > 0)
    ) {
      if (!stored.timeline.length && segments.length)
        takeIds = orderedProductionTakes(stored, takes, segments, true).map(
          (take) => take.id,
        );
      else takeIds = [];
    } else
      takeIds = orderedProductionTakes(
        stored,
        takes,
        segments,
        scope === "production",
      ).map((take) => take.id);
    if (scope !== "production" && !takeIds.length)
      throw new Error(
        "Select a rendered take or choose a clip before exporting.",
      );
    if (
      !takeIds.length &&
      !stored.timeline.length &&
      !stored.backgroundTracks?.length
    )
      throw new Error("Select production takes or add audio to the timeline.");
    if (
      range &&
      (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from)
    )
      throw new Error(
        "Choose a nonnegative range start and a later range end.",
      );
    return {
      ...settings,
      projectId: stored.id,
      revisionId: stored.revisionId,
      takeIds,
      includeBackground: scope === "production",
      ...(range ? { range: { from, to } } : {}),
    };
  }
  async function stored(): Promise<SpeechProject> {
    validateSpeechExportPreset(settings);
    changeSettings(settings);
    const value = await save();
    if (!value || value.id !== project.id)
      throw new Error("Reopen this project before producing audio.");
    return value;
  }
  async function preview(reuseCache: boolean): Promise<void> {
    const current = await stored();
    const request = input(current, true);
    const output = await runtime.execute("previewTimeline", {
      projectId: current.id,
      revisionId: current.revisionId,
      takeIds: request.takeIds,
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      loudnessLufs: settings.loudnessLufs,
      truePeakDb: settings.truePeakDb,
      includeBackground: scope === "production",
      reuseCache,
      ...(request.range ? { range: request.range } : {}),
    });
    await audition(output.id, assetUrl(output.asset.path));
  }
  return (
    <form
      className="tts-stack tts-export-panel"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setResult(null);
        void run(async () => {
          const current = await stored();
          const referencePermission=settings.format==="archive"?await archivePermissions.authorize(current):undefined;
          const output = await runtime.execute("export", {
            ...input(current),
            outputPath: String(data.get("outputPath")).trim(),
            overwrite: data.has("overwrite"),
            ...(referencePermission?{referencePermission}:{}),
          });
          setResult(output);
        });
      }}
    >
      <h2>Export</h2>
      {settings.format==="archive"&&<ArchivePermissions {...archivePermissions}/>}
      <div className="tts-grid">
        <Field label="Export preset">
          <select
            value={preset?.id ?? ""}
            onChange={(event) => {
              const preset = EXPORT_PRESETS.find(preset => preset.id === event.target.value);
              if (preset) setSettings({ ...preset.settings });
            }}
          >
            <option value="">Custom</option>
            {EXPORT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </Field>
        <Field label="Format">
          <select
            value={settings.format}
            onChange={(event) =>
              setSettings({
                ...settings,
                format: event.target.value as SpeechExportPreset["format"],
              })
            }
          >
            {FORMATS.map((format) => (
              <option key={format}>{format}</option>
            ))}
          </select>
        </Field>
        <div className="tts-wide"><Field label="Output path">
          <input name="outputPath" required />
        </Field></div>
      </div>
      <details className="tts-advanced"><summary>Advanced export settings</summary><div className="tts-stack">
      <div className="tts-grid">
        <Field label="Export target"><select value={scope} onChange={event => setScope(event.target.value as Scope)}>
          <option value="production">Production</option><option value="selected">Selected takes</option><option value="clip">Clip</option>
        </select></Field>
        {scope === "clip" && <Field label="Export clip"><select value={clipId} onChange={event => setClipId(event.target.value)}>
          <option value="">Choose clip</option>{takes.map((take, index) => <option key={take.id} value={take.id}>{index + 1} · {take.spokenText.slice(0, 60)}</option>)}
        </select></Field>}
        {audio && (
          <>
            <Field label="Sample rate (Hz)">
              <input
                type="number"
                min={8000}
                max={192000}
                step={1}
                value={
                  Number.isFinite(settings.sampleRate)
                    ? settings.sampleRate
                    : ""
                }
                required
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sampleRate: event.target.valueAsNumber,
                  })
                }
              />
            </Field>
            <Field label="Channels">
              <input
                type="number"
                min={1}
                max={2}
                step={1}
                value={
                  Number.isFinite(settings.channels) ? settings.channels : ""
                }
                required
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    channels: event.target.valueAsNumber,
                  })
                }
              />
            </Field>
            {compressed && (
              <Field label="Bitrate (bits/s)">
                <input
                  type="number"
                  min={16000}
                  max={512000}
                  step={1}
                  value={
                    Number.isFinite(settings.bitrate) ? settings.bitrate : ""
                  }
                  required
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      bitrate: event.target.valueAsNumber,
                    })
                  }
                />
              </Field>
            )}
            <Field label="Loudness (LUFS)">
              <input
                type="number"
                min={-70}
                max={-5}
                step="any"
                value={
                  settings.loudnessLufs === null ||
                  !Number.isFinite(settings.loudnessLufs)
                    ? ""
                    : settings.loudnessLufs
                }
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    loudnessLufs:
                      event.target.value === ""
                        ? null
                        : event.target.valueAsNumber,
                  })
                }
              />
            </Field>
            <Field label="True peak (dBTP)">
              <input
                type="number"
                min={-9}
                max={0}
                step="any"
                value={
                  settings.truePeakDb === null ||
                  !Number.isFinite(settings.truePeakDb)
                    ? ""
                    : settings.truePeakDb
                }
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    truePeakDb:
                      event.target.value === ""
                        ? null
                        : event.target.valueAsNumber,
                  })
                }
              />
            </Field>
          </>
        )}
      </div>
      <label className="tts-check">
        <input
          type="checkbox"
          checked={range}
          onChange={(event) => setRange(event.target.checked)}
        />
        Export range
      </label>
      {range && (
        <div className="tts-grid">
          <Field label="Export range start (s)">
            <input
              type="number"
              min={0}
              step="any"
              value={Number.isFinite(from) ? from : ""}
              onChange={(event) => setFrom(event.target.valueAsNumber)}
              required
            />
          </Field>
          <Field label="Export range end (s)">
            <input
              type="number"
              min={0}
              step="any"
              value={Number.isFinite(to) ? to : ""}
              onChange={(event) => setTo(event.target.valueAsNumber)}
              required
            />
          </Field>
        </div>
      )}
      <label className="tts-check">
        <input name="overwrite" type="checkbox" />
        Overwrite existing file
      </label>
      <div className="tts-row">
        <button type="button" disabled={busy} onClick={() => void run(async () => { await stored(); })}><Save size={16} />Save export settings</button>
        <button type="button" disabled={busy} onClick={() => void run(() => preview(false))}>Rebuild preview</button>
      </div>
      </div></details>
      <div className="tts-row">
        <button className="tts-primary" disabled={busy || settings.format !== "archive" && !hasAudio}>
          <Download size={16} />
          Export
        </button>
        <button
          type="button"
          disabled={busy || !hasAudio}
          onClick={() => void run(() => preview(true))}
        >
          <Play size={16} />
          Play production
        </button>
      </div>
      {result && (
        <div className="tts-stack" role="status">
          <a href={assetUrl(result.path)} download>
            Download export
          </a>
          {audio && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => audition(result.sha256, assetUrl(result.path)))
              }
            >
              Play export
            </button>
          )}
          <details><summary>File details</summary><span>{result.bytes} bytes</span><code>{result.sha256}</code></details>
        </div>
      )}
      <details className="tts-advanced"><summary>Batch exports</summary><BatchExports key={project.id} takes={takes} compiled={compiled} settings={settings} runtime={runtime} stored={stored} ready={analysisReady} busy={busy} run={run}/></details>
    </form>
  );
}
