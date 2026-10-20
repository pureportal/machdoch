import {useEffect, useState} from "react";
import type {SpeechDurationPricing, SpeechJob, SpeechRuntime, SpeechSettings, SpeechTake, SpeechTimingResult} from "@machdoch/speech";
import {speechTimingEstimate} from "@machdoch/speech";
import {Field, OWNER, type Run} from "./controls.tsx";

export function TranscriptTiming({runtime, takes, jobs, settings, selections, busy, run, report, onApply, onQueued, onSeek}: {
  runtime: SpeechRuntime; takes: SpeechTake[]; jobs: SpeechJob[]; settings: SpeechSettings | null;
  selections: Record<string, string>; busy: boolean; run: Run; report(error: unknown): void;
  onApply(takeId: string, timingId: string | null): Promise<void>; onQueued(): void;
  onSeek(take: SpeechTake, seconds: number): Promise<void>;
}) {
  const [takeId, setTakeId] = useState("");
  const [loaded, setLoaded] = useState<{takeId: string; records: SpeechTimingResult[]} | null>(null);
  const [resultId, setResultId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [language, setLanguage] = useState("");
  const [consent, setConsent] = useState(false);
  const [reuse, setReuse] = useState(true);
  const [priced, setPriced] = useState(false);
  const [rate, setRate] = useState("");
  const [increment, setIncrement] = useState("");
  const [currency, setCurrency] = useState("");
  const [source, setSource] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [budget, setBudget] = useState("");
  const [page, setPage] = useState(0);
  const take = takes.find(item => item.id === takeId);
  const completed = jobs.filter(job => job.kind === "alignment" && job.takeIds.includes(takeId) && job.state === "completed").map(job => job.id).sort().join(",");
  useEffect(() => { setResultId(""); setPage(0); setConsent(false); }, [takeId]);
  useEffect(() => {
    if (!takeId) return;
    let disposed = false;
    void runtime.execute("listTimings", {takeId}).then(records => { if (!disposed) setLoaded({takeId, records}); }).catch(error => { if (!disposed) report(error); });
    return () => { disposed = true; };
  }, [runtime, takeId, completed, refresh, report]);
  const records = loaded?.takeId === takeId ? loaded.records : [];
  const result = records.find(item => item.id === resultId);
  const pricing: SpeechDurationPricing | null = priced ? {perMinute: rate === "" ? NaN : Number(rate), billingIncrementSeconds: increment === "" ? NaN : Number(increment), currency, source, effectiveFrom, effectiveTo} : null;
  let estimate: ReturnType<typeof speechTimingEstimate> | null = null;
  let estimateError: string | null = null;
  if (take) { try { estimate = speechTimingEstimate(take.asset.duration, pricing); } catch (error) { estimateError = error instanceof Error ? error.message : String(error); } }
  const submit = async () => {
    if (!take) throw new Error("Choose a take before transcribing.");
    speechTimingEstimate(take.asset.duration, pricing);
    const limit = budget === "" ? null : Number(budget);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) throw new Error("Enter a nonnegative budget.");
    await runtime.execute("align", {owner: OWNER, takeId: take.id, provider: "openai", model: "whisper-1", language: language || null, pricing, budgetLimit: limit, cloudConsent: consent, reuseCache: reuse});
    onQueued();
  };
  return <details className="tts-timing">
    <summary>Word timing</summary>
    <Field label="Timing take"><select value={takeId} onChange={event => setTakeId(event.target.value)}>
      <option value="">Choose take</option>{takes.map(item => <option key={item.id} value={item.id}>{item.id} · {item.spokenText.slice(0, 64)}</option>)}
    </select></Field>
    {take && <>
      <form onSubmit={event => {event.preventDefault(); void run(submit);}}>
        <Field label="Transcription model"><select defaultValue="whisper-1"><option value="whisper-1">OpenAI Whisper 1</option></select></Field>
        <Field label="Language (ISO 639-1)"><input maxLength={2} pattern="[a-z]{2}" value={language} onChange={event => setLanguage(event.target.value)} /></Field>
        <label className="tts-check"><input type="checkbox" checked={reuse} onChange={event => setReuse(event.target.checked)} />Reuse matching timing</label>
        <label className="tts-check"><input type="checkbox" checked={priced} onChange={event => setPriced(event.target.checked)} />Use account rate</label>
        {priced && <div className="tts-row">
          <Field label="Rate per minute"><input type="number" min={0} step="any" required value={rate} onChange={event => setRate(event.target.value)} /></Field>
          <Field label="Billing increment (s)"><input type="number" min={1} max={3600} step={1} required value={increment} onChange={event => setIncrement(event.target.value)} /></Field>
          <Field label="Currency"><input pattern="[A-Z]{3}" maxLength={3} required value={currency} onChange={event => setCurrency(event.target.value)} /></Field>
          <Field label="Rate source"><input maxLength={2048} required value={source} onChange={event => setSource(event.target.value)} /></Field>
          <Field label="Effective from"><input type="date" required value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></Field>
          <Field label="Effective to"><input type="date" required value={effectiveTo} onChange={event => setEffectiveTo(event.target.value)} /></Field>
        </div>}
        <Field label="Budget limit"><input type="number" min={0} step="any" value={budget} onChange={event => setBudget(event.target.value)} /></Field>
        {estimateError ? <p role="alert">{estimateError}</p> : estimate && <output>{estimate.amount === null ? "Cost unavailable. Add an account rate to estimate a new transcription." : `New transcription estimate: ${estimate.amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${estimate.currency}`}</output>}
        <label className="tts-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Send this take to OpenAI for transcription</label>
        {!settings?.cloudConsent && consent && <p>Enable cloud speech requests in Settings before uploading audio.</p>}
        <button disabled={busy}>Transcribe take</button>
      </form>
      <div className="tts-row">
        <Field label="Timing transcript"><select value={resultId} onChange={event => {setResultId(event.target.value); setPage(0);}}>
          <option value="">Choose transcript</option>{records.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.words.length} words{selections[take.id] === item.id ? " · selected" : ""}</option>)}
        </select></Field>
        <button disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh transcripts</button>
        {selections[take.id] && <button disabled={busy} onClick={() => void run(() => onApply(take.id, null))}>Use synthesis timing</button>}
      </div>
      {result && <>
        <Field label="Script"><textarea readOnly dir="auto" rows={3} value={take.spokenText} /></Field>
        <Field label="Recognized transcript"><textarea readOnly dir="auto" rows={3} value={result.transcript} /></Field>
        <button disabled={busy || !result.words.length || selections[take.id] === result.id} onClick={() => void run(() => onApply(take.id, result.id))}>Use word timing</button>
        {!result.words.length && <p>No words were detected. Choose another transcript.</p>}
        <ol dir="auto" start={page * 100 + 1}>{result.words.slice(page * 100, page * 100 + 100).map((word, index) => <li key={page * 100 + index}>
          <button disabled={busy} onClick={() => void run(() => onSeek(take, word.start))}>{word.text} · {word.start.toFixed(3)}–{word.end.toFixed(3)} s</button>
        </li>)}</ol>
        {result.words.length > 100 && <div className="tts-row"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous words</button><button disabled={(page + 1) * 100 >= result.words.length} onClick={() => setPage(value => value + 1)}>Next words</button></div>}
        <details><summary>Timing evidence</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
      </>}
    </>}
  </details>;
}
