import {useEffect,useState} from "react";
import {Plus,Trash2,Users} from "lucide-react";
import type {SpeechProject,SpeechProfile,SpeechCastMember,SpeechRuntime} from "@machdoch/speech";
import {Field} from "./controls.tsx";
export function CastEditor({ project, edit, profile, runtime, report, chooseVoice }: {
  project: SpeechProject; edit(change: (value: SpeechProject) => SpeechProject): void; profile?: SpeechProfile;
  chooseVoice(id: string | null): void;
  runtime: SpeechRuntime; report(error: unknown): void;
}) {
  const [voiceNames,setVoiceNames] = useState<Record<string,string>>({});
  const voiceIds = JSON.stringify([...new Set(project.cast.flatMap(member => member.voiceId ? [member.voiceId] : []))].sort());
  useEffect(() => {
    if (profile?.backend !== "fish-cloud") return;
    let disposed = false;
    const ids: string[] = JSON.parse(voiceIds);
    void Promise.all(ids.map(async id => [id, (await runtime.execute("getVoice", {id})).name] as const)).then(names => {
      if (!disposed) setVoiceNames(Object.fromEntries(names));
    }).catch(error => { if (!disposed) report(error); });
    return () => { disposed = true; };
  }, [voiceIds,profile?.backend,runtime,report]);
  const change = (id: string, patch: Partial<SpeechCastMember>) => edit(value => ({
    ...value, cast: value.cast.map(member => member.id === id ? { ...member, ...patch } : member),
  }));
  return <section className="tts-stack tts-cast">
    <div className="tts-section-heading"><h2>{project.cast.length > 1 ? "Speakers" : "Voice"}</h2>{project.cast.length > 0 && <button className="tts-icon-button" aria-label="Add speaker" onClick={() => chooseVoice(null)}><Plus size={16} /></button>}</div>
    {!project.cast.length && <button className="tts-choose-voice" onClick={() => chooseVoice(null)}><Users size={16} />Choose voice</button>}
    {project.cast.map(member => <fieldset key={member.id} className="tts-cast-member">
      <legend>{member.name || "Speaker"}</legend>
      <div className="tts-grid">
      {project.cast.length > 1 && <h3>{member.name || "Speaker"}</h3>}
      {(member.voiceId || member.referenceAssetIds.length > 0) && <span className="tts-cast-voice">{member.referenceAssetIds.length ? "Reference recordings" : member.voiceId && (profile?.backend === "openai" || profile?.backend === "google" ? member.voiceId : voiceNames[member.voiceId])}</span>}
      <button className="tts-choose-voice" onClick={() => chooseVoice(member.id)}>{member.voiceId || member.referenceAssetIds.length ? "Change voice" : "Choose voice"}</button>
      </div>
      <details><summary>Speaker settings</summary><div className="tts-grid">
      <Field label="Speaker name"><input value={member.name} onChange={event => change(member.id, { name: event.target.value })} /></Field>
      <Field label="Direction"><input dir="auto" value={member.direction} onChange={event => change(member.id, { direction: event.target.value })} /></Field>
      <Field label="Voice ID"><input value={member.voiceId ?? ""} onChange={event => change(member.id, { voiceId: event.target.value || undefined,referenceAssetIds:[] })} /></Field>
      <Field label="Reference asset IDs"><input key={member.referenceAssetIds.join(",")} defaultValue={member.referenceAssetIds.join(", ")} onBlur={event => {
        const ids=event.target.value.split(",").map(value=>value.trim()).filter(Boolean);
        if(ids.join(",")!==member.referenceAssetIds.join(",")) change(member.id,{referenceAssetIds:ids,...(ids.length?{voiceId:undefined}:{})});
      }} /></Field>
      <Field label="Rights evidence"><input value={member.rightsEvidence ?? ""} onChange={event => change(member.id, { rightsEvidence: event.target.value })} /></Field>
      <button onClick={() => {
        if (!window.confirm("Remove this cast binding? Speaker cues in the script will need reassignment.")) return;
        edit(value => ({ ...value, cast: value.cast.filter(item => item.id !== member.id) }));
      }}><Trash2 size={16} />Remove speaker</button>
      </div></details>
    </fieldset>)}
  </section>;
}
