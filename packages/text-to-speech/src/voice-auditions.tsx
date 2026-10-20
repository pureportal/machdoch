import { useEffect,useRef, useState } from "react";
import type { SpeechTake,SpeechRuntime } from "@machdoch/speech";
import {Field} from "./controls.tsx";
import {
  addSpeechVoiceAudition,
  removeSpeechVoiceAudition,
} from "@machdoch/speech";
import type {
  SpeechVoiceAudition,
  SpeechVoiceAuditionInput,
  SpeechVoiceAuditionTake,
} from "@machdoch/speech";

export interface VoiceAuditionsProps {
  takes: readonly SpeechTake[];
  runtime:SpeechRuntime;
  reviews: readonly SpeechVoiceAudition[];
  onSave(reviews: SpeechVoiceAudition[]): Promise<void>;
  onListen(take: SpeechTake): Promise<void>;
}

type ListeningReview = Omit<SpeechVoiceAuditionInput, "id" | "reviewedAt">;

function ReviewForm({ evidence, saving, onAdd, onListen }: {
  evidence: SpeechVoiceAuditionTake;
  saving: boolean;
  onAdd(input: ListeningReview): Promise<boolean>;
  onListen(take: SpeechTake): Promise<void>;
}) {
  const [language, setLanguage] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [verdict, setVerdict] = useState<SpeechVoiceAudition["verdict"] | "">("");
  const [note, setNote] = useState("");
  const [played, setPlayed] = useState(false);
  const [listened, setListened] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playing = useRef(false);
  const { take, request } = evidence;
  const voiceId = request.segment.voiceIds.length === 1 ? request.segment.voiceIds[0] : undefined;
  const singleVoice = Boolean(voiceId?.trim());

  async function listen() {
    if (playing.current || saving) return;
    playing.current = true;
    setListening(true);
    setPlayed(false);
    setListened(false);
    setError(null);
    try {
      await onListen(take);
      setPlayed(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Playback failed. Try playing the take again.");
    } finally {
      playing.current = false;
      setListening(false);
    }
  }

  return <form className="tts-stack" onSubmit={event => {
    event.preventDefault();
    if (!voiceId || !played || !listened || !verdict || listening || saving) return;
    void onAdd({
      takeId: take.id, voiceId, language, reviewer, verdict, note, listened,
    }).then(saved => {
      if (saved) {
        setVerdict("");
        setNote("");
        setPlayed(false);
        setListened(false);
      }
    });
  }}>
    <p dir="auto">{take.spokenText}</p>
    <dl className="tts-row">
      <div><dt>Backend</dt><dd>{take.backend}</dd></div>
      <div><dt>Model</dt><dd>{take.model}</dd></div>
      {voiceId && <div><dt>Voice</dt><dd>{voiceId}</dd></div>}
    </dl>
    {!singleVoice && <p role="status">Render a take with exactly one voice to review a voice-language combination.</p>}
    <button type="button" disabled={!singleVoice || saving || listening} onClick={() => void listen()}>
      {listening ? "Starting playback…" : "Play take"}
    </button>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={!singleVoice || saving || listening} className="tts-stack">
      <legend>Listening review</legend>
      <Field label="Language tag"><input value={language} maxLength={64} onChange={event => { setLanguage(event.target.value); setListened(false); }} required /></Field>
      <Field label="Reviewer"><input value={reviewer} maxLength={256} onChange={event => setReviewer(event.target.value)} required /></Field>
      <Field label="Verdict"><select value={verdict} onChange={event => {
        const value = event.target.value;
        setVerdict(value === "approved" || value === "rejected" ? value : "");
      }} required>
        <option value="">Choose verdict</option>
        <option value="approved">Approved</option>
        <option value="rejected">Needs work</option>
      </select></Field>
      <Field label="Review notes"><textarea value={note} maxLength={4096} onChange={event => setNote(event.target.value)} dir="auto" /></Field>
      <label className="tts-check">
        <input type="checkbox" checked={listened} disabled={!played}
          onChange={event => setListened(event.target.checked)} required />
        I listened to this take in the language entered.
      </label>
      <button type="submit" disabled={!played || !listened || !verdict}>Save review</button>
    </fieldset>
  </form>;
}

export function VoiceAuditions({ takes, reviews, runtime,onSave, onListen }: VoiceAuditionsProps) {
  const [takeId, setTakeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const takeSelect = useRef<HTMLSelectElement>(null);
  const [selected,setSelected]=useState<SpeechVoiceAuditionTake>();
  const [reviewPage,setReviewPage]=useState(0);
  const selectedTake=takes.find(take=>take.id===takeId);
  useEffect(()=>{
    let active=true;setSelected(undefined);setError(null);
    if(selectedTake)void runtime.execute("takeRequest",{id:selectedTake.id}).then(request=>{if(active)setSelected({take:selectedTake,request});}).catch(error=>{if(active)setError(error instanceof Error?error.message:"The take request could not be loaded. Select it again.");});
    return ()=>{active=false;};
  },[selectedTake?.id,selectedTake?.requestHash,runtime]);
  const formKey = selected ? JSON.stringify([
    selected.take.id, selected.take.asset.id, selected.take.asset.sha256,
    selected.take.requestHash, selected.take.backend, selected.take.model, selected.take.generatedAt,
    selected.take.asset.bytes, selected.take.asset.duration, selected.take.segmentId, selected.take.spokenText,
    selected.request.connection.backend, selected.request.connection.model,
    selected.request.profile.backend, selected.request.profile.model,
    selected.request.segment.id, selected.request.segment.spokenText, selected.request.segment.voiceIds,
  ]) : "";

  async function persist(change: () => SpeechVoiceAudition[]): Promise<boolean> {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(change());
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save reviews. Try again.");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <section className="tts-stack" aria-busy={saving}>
    <h2>Voice-language reviews</h2>
    <Field label="Take"><select ref={takeSelect} value={selectedTake ? takeId : ""} disabled={saving || takes.length === 0}
      onChange={event => setTakeId(event.target.value)}>
      <option value="">Choose take</option>
      {takes.map((take, index) => <option key={take.id + ":" + index} value={take.id}>
        {take.id} · {take.spokenText.slice(0, 80)}
      </option>)}
    </select></Field>
    {takes.length === 0 && <p>Render a take before adding a listening review.</p>}
    {selected && <ReviewForm key={formKey} evidence={selected} saving={saving} onListen={onListen}
      onAdd={input => persist(() => addSpeechVoiceAudition(reviews, {
        ...input, id: crypto.randomUUID(), reviewedAt: new Date().toISOString(),
      }, [selected]))} />}
    {error && <p role="alert">{error}</p>}
    {reviews.length > 0 && <table>
      <caption>Listening reviews</caption>
      <thead><tr>
        <th scope="col">Voice</th><th scope="col">Language</th><th scope="col">Backend / model</th>
        <th scope="col">Take</th><th scope="col">Review</th><th scope="col">Reviewer</th><th scope="col">Actions</th>
      </tr></thead>
      <tbody>{reviews.slice(reviewPage*50,reviewPage*50+50).map((review, index) => {
        let problem: string | null = null;
        try {
          const take=takes.find(take=>take.id===review.takeId);
          if(!take||take.asset.sha256!==review.audioSha256||take.requestHash!==review.requestHash)throw new Error("This review's take evidence is unavailable. Reload the project.");
          if (reviews.filter(item => item.id === review.id).length !== 1) {
            problem = "Duplicate review ID. Reload reviews.";
          }
        } catch (failure) {
          problem = failure instanceof Error ? failure.message : "Take evidence is unavailable. Reload reviews.";
        }
        return <tr key={review.id + ":" + index}>
          <th scope="row">{review.voiceId}</th><td>{review.language}</td>
          <td>{review.backend} / {review.model}</td><td>{review.takeId}</td>
          <td>{problem ? <span role="alert">{problem}</span> : <>
            {review.verdict === "approved" ? "Approved" : "Needs work"}
            {review.note && <p dir="auto">{review.note}</p>}
          </>}</td>
          <td>{review.reviewer}<br /><time dateTime={review.reviewedAt}>{review.reviewedAt}</time></td>
          <td><button type="button" disabled={saving}
            aria-label={"Remove review by " + review.reviewer + " for " + review.voiceId + " in " + review.language}
            onClick={() => void persist(() => removeSpeechVoiceAudition(reviews, review.id)).then(saved => {
              if (saved) takeSelect.current?.focus();
            })}>Remove review</button></td>
        </tr>;
      })}</tbody>
    </table>}
    {reviews.length>50&&<div className="tts-row"><button type="button" disabled={reviewPage===0} onClick={()=>setReviewPage(page=>page-1)}>Previous reviews</button><button type="button" disabled={(reviewPage+1)*50>=reviews.length} onClick={()=>setReviewPage(page=>page+1)}>Next reviews</button></div>}
  </section>;
}
