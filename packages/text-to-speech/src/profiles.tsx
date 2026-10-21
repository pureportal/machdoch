import {useState} from "react";
import {Save,Settings2,Trash2,Plus} from "lucide-react";
import type {SpeechProfile,SpeechDictionary,SpeechBackend,SpeechSettings,SpeechRuntime,SpeechAsset} from "@machdoch/speech";
import {Field,BACKENDS,BACKEND_LABELS,type Run} from "./controls.tsx";
import {ProfileReferences} from "./profile-references.tsx";
export function ProfilesPanel({ runtime, profiles, dictionaries, settings, run, busy, saved, deleted,playReference,openSettings }: {
  runtime: SpeechRuntime; profiles: SpeechProfile[]; dictionaries: SpeechDictionary[]; settings: SpeechSettings | null;
  run: Run; busy: boolean; saved(profile: SpeechProfile): void; deleted(id: string): void;
  playReference(asset:SpeechAsset):Promise<void>;
  openSettings():void;
}) {
  const connections = BACKENDS.flatMap(backend => settings?.connections.filter(connection => connection.backend === backend && connection.configured) ?? []);
  const fresh = (): SpeechProfile => ({
    id: crypto.randomUUID(), name: "", backend: connections[0]?.backend ?? "drama3",
    model: connections[0]?.model ?? "",
    voiceId: connections[0]?.backend === "openai" ? "cedar" : connections[0]?.backend === "google" ? "Kore" : "", language: "", normalize: true, direction: "", temperature: 0.7, topP: 0.7,
    chunkLength: 300, minChunkLength: 50, latency: "normal", dictionaryIds: [], playbackRate: 1,
  });
  const [draft, setDraft] = useState<SpeechProfile>(fresh);
  const [source,setSource]=useState<"voice"|"references">(() => ["sglang","drama3"].includes(draft.backend) ? "references" : "voice");
  const existing = profiles.some(item => item.id === draft.id);
  const configured = connections.some(connection => connection.backend === draft.backend);
  const patch = (change: Partial<SpeechProfile>) => setDraft(value => ({ ...value, ...change }));
  const fish = draft.backend === "fish-cloud";
  const drama = fish || draft.backend === "sglang" || draft.backend === "drama3";
  const numericFields = [
    { key: "temperature", label: "Temperature", min: 0, max: fish ? 1 : 2, step: "any", visible: drama },
    { key: "topP", label: "Top P", min: 0, max: 1, step: "any", visible: drama },
    { key: "chunkLength", label: "Chunk length", min: 100, max: 300, step: "1", visible: fish },
    { key: "minChunkLength", label: "Minimum chunk length", min: 0, max: 100, step: "1", visible: fish },
    { key: "playbackRate", label: "Playback speed", min: 0.25, max: 4, step: "any", visible: true },
  ] as const;
  return <div className="tts-stack">
    <div className="tts-section-heading"><h2>Profiles</h2><div className="tts-row">
      <select aria-label="Edit profile" value={existing ? draft.id : ""} onChange={event => {
        const item = profiles.find(profile => profile.id === event.target.value);
        if (item) {setDraft({ ...item, dictionaryIds: [...item.dictionaryIds] });setSource(["sglang","drama3"].includes(item.backend)||item.referenceAssetIds?.length?"references":"voice");}
      }}><option value="">New profile</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button disabled={!connections.length} onClick={() => {const next=fresh();setDraft(next);setSource(["sglang","drama3"].includes(next.backend)?"references":"voice");}}><Plus size={16} aria-hidden="true" />New profile</button>
    </div></div>
    {!connections.length ? <div className="tts-empty"><button onClick={openSettings}><Settings2 size={16} aria-hidden="true" />Configure provider</button></div> : <form className="tts-stack tts-profile-editor" onSubmit={event => {
      event.preventDefault();
      if (!configured) return;
      void run(async () => {
        if (draft.topP > 1) throw new Error("Top P must be between zero and one.");
        if (draft.playbackRate > 4 || draft.playbackRate <= 0) throw new Error("Playback speed must be above zero and at most four.");
        if (draft.minChunkLength > draft.chunkLength) throw new Error("Minimum chunk length must not exceed chunk length.");
        const result = await runtime.execute("saveProfile", { profile: { ...draft, name: draft.name.trim(), model: draft.model.trim(), voiceId: source==="voice"?draft.voiceId?.trim()||undefined:undefined,referenceAssetIds:source==="references"?draft.referenceAssetIds??[]:undefined } });
        saved(result); setDraft(result);
      });
    }}>
      <div className="tts-grid">
        <Field label="Name"><input value={draft.name} required onChange={event => patch({ name: event.target.value })} /></Field>
        <Field label="Provider"><select value={configured ? draft.backend : ""} required onChange={event => {
          const backend = event.target.value as SpeechBackend;
          setSource(["sglang","drama3"].includes(backend)?"references":"voice");
          setDraft(value => {
            const next = { ...value, backend, model: settings?.connections.find(item => item.backend === backend)?.model ?? (backend === "openai" ? "gpt-4o-mini-tts" : backend === "google" ? "gemini-3.1-flash-tts-preview" : "drama-3"),
              voiceId: backend === "openai" ? "cedar" : backend === "google" ? "Kore" : "", language: "", dictionaryIds: [],
              temperature: 0.7, topP: 0.7, chunkLength: 300, minChunkLength: 50, latency: "normal" as const };
            if (backend === "fish-cloud") next.normalize = true;
            else delete next.normalize;
            delete next.referenceAssetIds;
            return next;
          });
        }}><option value="" disabled>Select provider</option>{connections.map(connection => <option key={connection.backend} value={connection.backend}>{BACKEND_LABELS[connection.backend]}</option>)}</select></Field>
        <Field label="Model"><input value={draft.model} required readOnly /></Field>
        {fish&&<Field label="Voice source"><select value={source} onChange={event=>{const source=event.target.value as "voice"|"references";setSource(source);patch({voiceId:"",referenceAssetIds:[]});}}><option value="voice">Voice ID</option><option value="references">Reference recordings</option></select></Field>}
        {!["sglang","drama3"].includes(draft.backend)&&source==="voice" && <Field label="Default voice ID"><input value={draft.voiceId ?? ""} readOnly={!drama} onChange={event => patch({ voiceId: event.target.value })} /></Field>}
        {draft.backend === "google" && <Field label="Spoken language"><select value={draft.language ?? ""} onChange={event => patch({ language: event.target.value })}>
          <option value="">Automatic</option>{GOOGLE_LANGUAGES.map(language => <option key={language}>{language}</option>)}
        </select></Field>}
        <div className="tts-wide"><Field label="Direction"><textarea dir="auto" value={draft.direction} onChange={event => patch({ direction: event.target.value })} /></Field></div>
      </div>
      {drama&&source==="references"&&<ProfileReferences runtime={runtime} value={draft.referenceAssetIds??[]} change={referenceAssetIds=>patch({referenceAssetIds})} busy={busy} run={run} play={playReference}/>}
      <details className="tts-advanced"><summary>Advanced settings</summary><div className="tts-stack"><div className="tts-grid">
        {fish && <>
          <label className="tts-check"><input type="checkbox" checked={draft.normalize ?? true} onChange={event => patch({ normalize: event.target.checked })} />Normalize numbers, dates and units</label>
          <Field label="Normalization language"><input value={draft.language ?? ""} placeholder="Automatic" maxLength={35} pattern="[A-Za-z0-9_-]*" onChange={event => patch({ language: event.target.value })} /></Field>
        </>}
        {numericFields.filter(field => field.visible).map(field => <Field key={field.key} label={field.label}><input type="number" min={field.min}
          max={field.max} step={field.step}
          value={Number.isFinite(draft[field.key]) ? draft[field.key] : ""} required
          onChange={event => patch({ [field.key]: event.target.valueAsNumber })} /></Field>)}
        {fish && <Field label="Latency"><select value={draft.latency} onChange={event => patch({ latency: event.target.value as SpeechProfile["latency"] })}>
          <option value="normal">Normal</option><option value="balanced">Balanced</option><option value="low">Low</option>
        </select></Field>}
      </div>
      {fish && dictionaries.length > 0 && <fieldset className="tts-stack"><legend>Pronunciation dictionaries</legend>
        {dictionaries.map(dictionary => <label className="tts-check" key={dictionary.id}><input type="checkbox" checked={draft.dictionaryIds.includes(dictionary.id)}
          onChange={event => patch({ dictionaryIds: event.target.checked ? [...draft.dictionaryIds, dictionary.id] : draft.dictionaryIds.filter(id => id !== dictionary.id) })} />{dictionary.name}</label>)}
      </fieldset>}
      </div></details>
      <div className="tts-row"><button className="tts-primary" disabled={busy || !configured}><Save size={16} aria-hidden="true" />Save profile</button>
        <button type="button" className="tts-icon-button tts-danger" aria-label="Delete profile" title="Delete profile" disabled={busy || !existing} onClick={() => void run(async () => {
          if (!window.confirm("Delete the profile “" + draft.name + "”?")) return;
          await runtime.execute("deleteProfile", { id: draft.id });
          const next=fresh();deleted(draft.id);setDraft(next);setSource(["sglang","drama3"].includes(next.backend)?"references":"voice");
        })}><Trash2 size={16} aria-hidden="true" /></button>
      </div>
    </form>}
  </div>;
}

const GOOGLE_LANGUAGES = ["de-DE", "en-AU", "en-GB", "en-IN", "en-US", "es-US", "fr-FR", "hi-IN", "pt-BR", "ar-XA", "es-ES", "fr-CA", "id-ID", "it-IT", "ja-JP", "tr-TR", "vi-VN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "ta-IN", "te-IN", "nl-NL", "ko-KR", "cmn-CN", "pl-PL", "ru-RU", "th-TH"];
