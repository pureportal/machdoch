import {useEffect,useState} from "react";
import {Play,Save,Star,Trash2} from "lucide-react";
import {type SpeechTake,type SpeechTakeRequest,type SpeechRuntime,type SpeechSettings,type SpeechTimelineClip,type PlaybackState} from "@machdoch/speech";
import {Field,formNumber,OWNER,type Run} from "./controls.tsx";
import {Waveform} from "./waveform.tsx";
import {DirectorNotes} from "./director-notes.tsx";
import {ProviderResponseFields} from "./provider-response.tsx";
import {VoiceObservationFields} from "./voice-observations.tsx";
export function TakeRow({ take, selected, busy, audition, update, select, addClip, handoff, run, runtime, seek,settings,onQueued }: {
  take: SpeechTake; selected: boolean; busy: boolean; audition(): Promise<void>;
  update(changes: { favorite?: boolean; note?: string }): Promise<void>;
  select(): void; addClip(range?: {from:number;to:number}): void; handoff?: () => Promise<void>; run: Run;
  runtime: SpeechRuntime; seek(seconds:number): Promise<void>;
  settings:SpeechSettings|null;onQueued():void;
}) {
  const [note, setNote] = useState(take.note);
  const [showWaveform,setShowWaveform] = useState(false);
  const [generation,setGeneration] = useState<SpeechTakeRequest|null>(null);
  useEffect(() => setNote(take.note), [take.note]);
  return <article className="tts-take" data-take-id={take.id} data-selected={selected}>
    <p dir="auto">{take.spokenText}</p>
    <div className="tts-row tts-take-meta">
      <span>{new Date(take.createdAt).toLocaleString()}</span>
      <span>{take.model}</span><span>{take.asset.duration.toFixed(2)} s</span></div>
    <div className="tts-row tts-take-actions">
      <button onClick={() => void run(audition)}><Play size={16} />Audition</button>
      <button aria-pressed={take.favorite} aria-label={take.favorite ? "Remove favorite take" : "Favorite take"} disabled={busy}
        onClick={() => void run(() => update({ favorite: !take.favorite }))}><Star size={16} fill={take.favorite ? "currentColor" : "none"} /></button>
      <button aria-pressed={selected} onClick={select}>{selected ? "Selected" : "Select take"}</button>
      <button onClick={() => void run(async () => addClip())}>Add to timeline</button>
      {handoff && <button disabled={busy} onClick={() => void run(handoff)}>Open in Media</button>}
    </div>
    <details className="tts-take-details"><summary>Take details</summary><div className="tts-stack">
    <details><summary>Provenance</summary><dl className="tts-metadata">
      <dt>Segment</dt><dd>{take.segmentId}</dd><dt>Revision</dt><dd>{take.revisionId}</dd>
      <dt>Provider</dt><dd>{take.backend}</dd><dt>Request hash</dt><dd>{take.requestHash}</dd>
      <dt>Asset</dt><dd>{take.asset.sha256}</dd>
      <dt>Generated</dt><dd>{new Date(take.generatedAt).toLocaleString()}</dd>
      {take.reusedFromTakeId && <><dt>Reused take</dt><dd>{take.reusedFromTakeId}</dd></>}
      {take.parentTakeId && <><dt>Parent take</dt><dd>{take.parentTakeId}</dd></>}
      <ProviderResponseFields response={take.providerResponse}/>
      <VoiceObservationFields observations={take.voiceObservations}/>
    </dl>
      <button type="button" disabled={busy} onClick={() => void run(async () => setGeneration(await runtime.execute("takeRequest",{id:take.id})))}>Load generation settings</button>
      {generation && <dl className="tts-metadata">
        <dt>Profile</dt><dd>{generation.profile.name}</dd>
        <dt>Direction</dt><dd>{generation.profile.direction}</dd>
        <dt>Voices</dt><dd>{generation.segment.voiceIds.join(", ")}</dd>
        {["fish-cloud","sglang","drama3"].includes(generation.profile.backend) && <><dt>Temperature</dt><dd>{generation.profile.temperature}</dd>
        <dt>Top P</dt><dd>{generation.profile.topP}</dd></>}
        {generation.profile.backend === "fish-cloud" && <><dt>Text normalization</dt><dd>{generation.profile.normalize === undefined ? "Provider default" : generation.profile.normalize ? "On" : "Off"}</dd></>}
        {generation.profile.language && <><dt>Language</dt><dd>{generation.profile.language}</dd></>}
        {generation.connection.runtimeVersion && <><dt>Runtime</dt><dd>{generation.connection.runtimeVersion}</dd></>}
        <dt>Dictionaries</dt><dd>{generation.dictionaries.map(dictionary=>dictionary.name+" · "+dictionary.revision).join(", ")}</dd>
        <dt>References</dt><dd>{Object.values(generation.references).map(reference=>reference.transcript).join("; ")}</dd>
      </dl>}
    </details>
    <DirectorNotes key={take.id} runtime={runtime} take={take} settings={settings} busy={busy} run={run} onQueued={onQueued}/>
    <details><summary>Notes</summary><form className="tts-row" onSubmit={event => { event.preventDefault(); void run(() => update({ note })); }}>
      <Field label="Notes"><textarea value={note} dir="auto" onChange={event => setNote(event.target.value)} /></Field>
      <button disabled={busy || note === take.note}>Save notes</button>
    </form></details>
    </div></details>
    <details onToggle={event => setShowWaveform(event.currentTarget.open)}><summary>Waveform</summary>
      {showWaveform && <Waveform runtime={runtime} take={take} onSeek={seconds => {void run(() => seek(seconds));}}
        onTrim={(from,to) => addClip({from,to})} />}
    </details>
  </article>;
}

export function TakeComparison({ takes, playback, audition, run,onSelectionChange }: {
  takes: SpeechTake[]; playback: PlaybackState; audition(take: SpeechTake, position: number): Promise<void>; run: Run;
  onSelectionChange(ids:string[]):void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  useEffect(()=>onSelectionChange([a,b].filter(Boolean)),[a,b,onSelectionChange]);
  const [matched, setMatched] = useState(true);
  const play = (id: string) => {
    const take = takes.find(item => item.id === id);
    if (!take) return;
    const position = matched && playback.owner === OWNER && [a, b].includes(playback.itemId ?? "")
      ? Math.min(playback.position, Math.max(0, take.asset.duration - 0.01)) : 0;
    void run(() => audition(take, position));
  };
  return <fieldset className="tts-row">
    <legend>A/B</legend>
    {([{ key: "A", value: a, set: setA }, { key: "B", value: b, set: setB }]).map(item => <div className="tts-row" key={item.key}>
      <Field label={item.key}><select value={item.value} onChange={event => item.set(event.target.value)}>
        <option value="">Choose take</option>{takes.map((take, index) => <option key={take.id} value={take.id}>{index + 1} · {take.model} · {new Date(take.createdAt).toLocaleTimeString()}</option>)}
      </select></Field>
      <button disabled={!takes.some(take => take.id === item.value)} onClick={() => play(item.value)}>Play {item.key}</button>
    </div>)}
    <label className="tts-check"><input type="checkbox" checked={matched} onChange={event => setMatched(event.target.checked)} />Match position</label>
  </fieldset>;
}

export function TimelineClip({ clip, take, save, remove, report }: {
  clip: SpeechTimelineClip; take?: SpeechTake; save(value: SpeechTimelineClip): void; remove(): void; report(error: unknown): void;
}) {
  const fields = [
    { key: "start", label: "Start (s)" }, { key: "in", label: "Trim in (s)" }, { key: "out", label: "Trim out (s)" },
    { key: "gain", label: "Gain" }, { key: "fadeIn", label: "Fade in (s)" }, { key: "fadeOut", label: "Fade out (s)" }, { key: "track", label: "Track" },
  ] as const;
  return <article className="tts-clip">
    <p dir="auto">{take?.spokenText ?? "Audio clip"}</p>
    <div className="tts-row tts-take-meta"><span>{clip.start.toFixed(1)} s</span><span>{(clip.out - clip.in).toFixed(1)} s duration</span></div>
    <details><summary>Clip settings</summary><form key={JSON.stringify(clip)} className="tts-grid" onSubmit={event => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const updated = { ...clip };
      for (const field of fields) updated[field.key] = formNumber(data, field.key);
      if (updated.out <= updated.in) throw new Error("Trim out must follow trim in.");
      if (take && updated.out > take.asset.duration) throw new Error("Keep trim out within the take duration.");
      if (!Number.isInteger(updated.track)) throw new Error("Enter a whole track number.");
      if (updated.fadeIn > updated.out - updated.in || updated.fadeOut > updated.out - updated.in) throw new Error("Keep each fade within the trimmed clip duration.");
      save(updated);
    } catch (failure) { report(failure); }
  }}>
    {fields.map(field => <Field key={field.key} label={field.label}>
      <input name={field.key} type="number" min={0} max={field.key==="track"?1023:field.key==="gain"?16:undefined} step={field.key === "track" ? 1 : "any"} defaultValue={clip[field.key]} required />
    </Field>)}
    <button><Save size={16} />Apply clip</button><button type="button" onClick={remove}><Trash2 size={16} />Remove clip</button>
  </form></details></article>;
}
