import {useEffect,useRef,useState} from "react";
import {ArrowLeft,ArrowRight,Check,Filter,Hash,MoreHorizontal,Play,RefreshCw,Search,Star,Trash2,X} from "lucide-react";
import type {SpeechVoice,SpeechAsset,SpeechOperations,SpeechSettings,SpeechRuntime,SpeechReferenceImport,SpeechProfile} from "@machdoch/speech";
import {Field,OWNER,type Run} from "./controls.tsx";
import {ReferenceRecorder} from "./reference-recorder.tsx";
import {VoiceComparison} from "./voice-comparison.tsx";
import {VoiceWorkflows} from "./voice-workflows.tsx";
import {VoiceReviewHistory} from "./voice-review-history.tsx";
import {VoiceMutationHistory,voiceMutationFailure} from "./voice-mutations.tsx";
import {VoiceEditor} from "./voice-editor.tsx";
const RECORDING_PERMISSION = "I have permission to use these recordings and create this voice.";
export function VoiceLibrary({ runtime, active, settings, profiles, run, busy, report, audition, assetUrl, canBind, bindVoice, bindReferences,openProject }: {
  runtime: SpeechRuntime; active: boolean; settings: SpeechSettings | null; profiles:SpeechProfile[];run: Run; busy: boolean;
  report(error: unknown): void; audition(id: string, url: string, position?: number): Promise<void>; assetUrl(path: string): string;
  canBind: boolean; bindVoice(id: string): void; bindReferences(ids: string[], rights: string): void;
  openProject(id:string):Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("");
  const [own, setOwn] = useState(false);
  const [favoritesOnly,setFavoritesOnly]=useState(false);
  const [query, setQuery] = useState({ search: "", language: "", own: false,favorites:false });
  const [page, setPage] = useState(1);
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [loadedOwn, setLoadedOwn] = useState(false);
  const [missingFavorites,setMissingFavorites]=useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [mutationReload,setMutationReload]=useState(0);
  const [lookup, setLookup] = useState<SpeechVoice | null>(null);
  const lookupInput=useRef<HTMLInputElement>(null);
  const [comparisonVoices,setComparisonVoices]=useState<SpeechVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [references, setReferences] = useState<Array<{ asset: SpeechAsset; transcript: string; originalAsset?: SpeechAsset; quality?: SpeechReferenceImport["quality"] }>>([]);
  const [savedReferences, setSavedReferences] = useState<SpeechOperations["listReferences"]["output"]>({ references: [], total: 0 });
  const [referencePage, setReferencePage] = useState(0);
  const [referenceReload, setReferenceReload] = useState(0);
  const [permission, setPermission] = useState(false);
  const rights = permission ? RECORDING_PERMISSION : "";
  const pageSize = 20;
  const fishConfigured = !!settings?.connections.some(connection => connection.backend === "fish-cloud" && connection.configured);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void runtime.execute("listReferences", { offset: referencePage * 50, limit: 50 }).then(value => { if (!disposed) setSavedReferences(value); }).catch(report);
    return () => { disposed = true; };
  }, [active, referencePage, referenceReload, runtime, report]);
  const imported = (reference: SpeechReferenceImport): void => {
    setReferences(items => [...items.filter(item => item.asset.id !== reference.asset.id), reference]);
    setReferenceReload(value => value + 1);
  };

  useEffect(() => {
    if (!active || !fishConfigured) return;
    let disposed = false;
    setLoading(true);
    const load=query.favorites?runtime.execute("listFavoriteVoices",{offset:(page-1)*pageSize,limit:pageSize,search:query.search,language:query.language||undefined}).then(result=>({voices:result.favorites.flatMap(item=>item.voice?[item.voice]:[]),missing:result.favorites.filter(item=>!item.voice).map(item=>item.id),total:result.total})):
      runtime.execute("listVoices", { page, pageSize, search: query.search, language: query.language || undefined, own: query.own }).then(result=>({...result,missing:[] as string[]}));
    void load.then(result => {
      if (!disposed) { setVoices(result.voices);setMissingFavorites(result.missing); setTotal(result.total);setLoadedOwn(query.own&&!query.favorites); }
    }).catch(failure => { if (!disposed) report(failure); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [runtime, active, fishConfigured, page, query, reload, report]);

  const voiceRow = (voice: SpeechVoice, deletable: boolean) => <article key={voice.id} className="tts-voice">
    <div className="tts-voice-heading"><div><h3>{voice.name}</h3>{voice.author && <span>{voice.author}</span>}</div>
      <button className="tts-icon-button" aria-pressed={voice.favorite} aria-label={voice.favorite ? "Remove favorite voice" : "Favorite voice"} disabled={busy} onClick={() => void run(async () => {
        await runtime.execute("favoriteVoice", { id: voice.id, favorite: !voice.favorite });
        setVoices(items => items.map(item => item.id === voice.id ? { ...item, favorite: !voice.favorite } : item));
        setLookup(item => item?.id === voice.id ? { ...item, favorite: !voice.favorite } : item);
        if(query.favorites)setReload(value=>value+1);
      })} title={voice.favorite ? "Remove favorite voice" : "Favorite voice"}><Star size={16} aria-hidden="true" fill={voice.favorite ? "currentColor" : "none"} /></button>
    </div>
    {!!voice.languages.length && <span>{voice.languages.join(", ")}</span>}
    <div className="tts-row tts-voice-actions">
      {voice.previewUrl && <button className="tts-icon-button" aria-label="Preview" title="Preview" onClick={() => void run(() => audition("voice:" + voice.id, voice.previewUrl!))}><Play size={16} aria-hidden="true" /></button>}
      {canBind && <button className="tts-assign-voice" disabled={loading} onClick={() => bindVoice(voice.id)}><Check size={16} aria-hidden="true" />Assign voice</button>}
      {query.favorites&&<button className="tts-icon-button" aria-label="Refresh voice" title="Refresh voice" disabled={busy || loading} onClick={()=>void run(async()=>{setLookup(await runtime.execute("getVoice",{id:voice.id}));setReload(value=>value+1);})}><RefreshCw size={16} aria-hidden="true" /></button>}
      <details className="tts-menu tts-voice-options"><summary aria-label={`Options for ${voice.name}`}><MoreHorizontal size={18} /></summary><div className="tts-menu-content tts-stack">
      <button aria-pressed={comparisonVoices.some(item=>item.id===voice.id)} disabled={busy||comparisonVoices.length>=32&&!comparisonVoices.some(item=>item.id===voice.id)} onClick={()=>setComparisonVoices(values=>values.some(item=>item.id===voice.id)?values.filter(item=>item.id!==voice.id):[...values,voice])}>Compare voice</button>
      {deletable&&<VoiceEditor voice={voice} runtime={runtime} run={run} busy={busy || loading} onChanged={()=>{setMutationReload(value=>value+1);setLookup(item=>item?.id===voice.id?null:item);setReload(value=>value+1);lookupInput.current?.closest("details")?.querySelector("summary")?.focus();}}/>}
      {deletable && <button disabled={busy || loading} onClick={() => void run(async () => {
        if (!window.confirm("Delete the Fish voice “" + voice.name + "” from your account?")) return;
        const result=await runtime.execute("deleteVoice", { id: voice.id, confirmed: true });setMutationReload(value=>value+1);
        if(result.state!=="deleted"&&result.state!=="unavailable")throw new Error(voiceMutationFailure(result));
        setLookup(item => item?.id === voice.id ? null : item);
        setComparisonVoices(items=>items.filter(item=>item.id!==voice.id));
        setReload(value => value + 1);
        lookupInput.current?.closest("details")?.querySelector("summary")?.focus();
        if(result.state==="unavailable")throw new Error(voiceMutationFailure(result));
      })}><Trash2 size={16} />Delete voice</button>}
      <code>{voice.id}</code><span>{voice.visibility}</span>{voice.rights && <span>{voice.rights}</span>}
      </div></details>
    </div>
  </article>;

  return <div className="tts-stack">
    <h2>Voices</h2>
    {fishConfigured && <>
    <div className="tts-row tts-voice-search">
    <form className="tts-row" role="search" aria-label="Voices" onSubmit={event => {
      event.preventDefault(); setPage(1); setQuery({ search, language, own,favorites:favoritesOnly }); setReload(value => value + 1);
    }}>
      <Field label="Search voices"><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
      <button className="tts-icon-button" aria-label="Search" title="Search" disabled={loading}><Search size={16} aria-hidden="true" /></button>
      <details className="tts-menu tts-voice-filters" data-active={!!query.language || query.own || query.favorites}><summary aria-label="Filters" title="Filters"><Filter size={16} aria-hidden="true" /></summary><div className="tts-menu-content tts-stack">
      <Field label="Language"><input value={language} onChange={event => setLanguage(event.target.value)} /></Field>
      <label className="tts-check"><input type="checkbox" checked={own} onChange={event => {setOwn(event.target.checked);if(event.target.checked)setFavoritesOnly(false);}} />My voices</label>
      <label className="tts-check"><input type="checkbox" checked={favoritesOnly} onChange={event=>{setFavoritesOnly(event.target.checked);if(event.target.checked)setOwn(false);}}/>Favorites</label>
      <button>Apply filters</button>
      </div></details>
    </form>
      <details className="tts-menu"><summary aria-label="Find by voice ID"><Hash size={16} aria-hidden="true" />Voice ID</summary>
      <form className="tts-menu-content tts-stack" onSubmit={event => {
        event.preventDefault();
        const id=lookupInput.current?.value.trim();
        if (id) void run(async () => setLookup(await runtime.execute("getVoice", { id })));
      }}><Field label="Voice ID"><input ref={lookupInput} name="voiceId" required /></Field><button disabled={busy || loading}>Open voice</button>
      </form></details>
    </div>
    <div className="tts-voice-results">
    {lookup && <div className="tts-voice-lookup"><button className="tts-icon-button" aria-label="Close voice" title="Close voice" onClick={() => {setLookup(null);lookupInput.current?.closest("details")?.querySelector("summary")?.focus();}}><X size={16} aria-hidden="true" /></button>{voiceRow(lookup, false)}</div>}
    <div className="tts-voice-list" aria-busy={loading}>{voices.map(voice => voiceRow(voice, loadedOwn))}
      {missingFavorites.map(id=><article key={id} className="tts-voice"><code>{id}</code><div className="tts-row"><button disabled={busy || loading} onClick={()=>void run(async()=>{setLookup(await runtime.execute("getVoice",{id}));setReload(value=>value+1);})}>Open voice</button><button className="tts-icon-button" aria-label="Remove favorite" title="Remove favorite" disabled={busy || loading} onClick={()=>void run(async()=>{await runtime.execute("favoriteVoice",{id,favorite:false});setReload(value=>value+1);})}><Star size={16} aria-hidden="true" /></button></div></article>)}
    </div>
    {!voices.length && !missingFavorites.length && <div className="tts-voice-empty" role="status">
      <p className="tts-muted">{loading ? "Loading voices…" : "No voices found."}</p>{!loading && (query.search || query.language || query.own || query.favorites) && <button onClick={() => {
        setSearch(""); setLanguage(""); setOwn(false); setFavoritesOnly(false); setPage(1); setQuery({ search: "", language: "", own: false, favorites: false });
      }}>Clear filters</button>}
    </div>}
    </div>
    <nav className="tts-voice-pages" aria-label="Voice pages" aria-busy={loading}>
      <button className="tts-icon-button" aria-label="Previous" title="Previous" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}><ArrowLeft size={16} aria-hidden="true" /></button>
      <span role="status">{loading ? "Loading voices…" : total ? `Page ${page} · ${total} voices` : "0 voices"}</span>
      <button className="tts-icon-button" aria-label="Next" title="Next" disabled={loading || page * pageSize >= total} onClick={() => setPage(value => value + 1)}><ArrowRight size={16} aria-hidden="true" /></button>
    </nav>
    {comparisonVoices.length>=32&&<p>Select up to 32 voices for one comparison.</p>}
    {comparisonVoices.length > 0 && <VoiceComparison runtime={runtime} active={active} voices={comparisonVoices} remove={id=>setComparisonVoices(values=>values.filter(voice=>voice.id!==id))} profiles={profiles} settings={settings} assetUrl={assetUrl} run={run} busy={busy} assign={canBind?bindVoice:undefined}/>}
    </>}
    <details className="tts-advanced"><summary>{fishConfigured ? "Create or clone a voice" : "Reference recordings"}</summary><div className="tts-stack">
    <section className="tts-stack">
      {fishConfigured && <h2>Reference recordings</h2>}
      <label className="tts-check"><input type="checkbox" checked={permission} onChange={event => setPermission(event.target.checked)} />{RECORDING_PERMISSION}</label>
      <ReferenceRecorder runtime={runtime} active={active} rights={rights} permission={permission} busy={busy} run={run} report={report} imported={imported} />
      {savedReferences.total > 0 && <div className="tts-row"><Field label="Saved recording"><select value="" onChange={event => {
        const reference = savedReferences.references.find(reference => reference.asset.id === event.target.value);
        if (reference) setReferences(items => [...items.filter(item => item.asset.id !== reference.asset.id), reference]);
      }}><option value="">Choose recording</option>{savedReferences.references.map(reference => <option key={reference.asset.id} value={reference.asset.id}>{reference.transcript.slice(0, 100)}</option>)}</select></Field>
        <button disabled={referencePage === 0} onClick={() => setReferencePage(value => value - 1)}>Previous recordings</button>
        <button disabled={(referencePage + 1) * 50 >= savedReferences.total} onClick={() => setReferencePage(value => value + 1)}>Next recordings</button>
      </div>}
      <ul className="tts-reference-list">{references.map((item, index) => <li key={item.asset.id + ":" + index}>
        <span>{item.transcript.slice(0, 100)}</span><span>{item.asset.duration.toFixed(2)} s</span>
        <button onClick={() => void run(() => audition("reference:" + item.asset.id, assetUrl(item.asset.path)))}>Preview</button>
        <button onClick={() => setReferences(items => items.filter((_, position) => position !== index))}>Remove from set</button>
        {item.originalAsset && item.originalAsset.id !== item.asset.id && <button onClick={() => void run(() => audition("reference-source:" + item.originalAsset!.id, assetUrl(item.originalAsset!.path)))}>Preview source</button>}
        {item.quality && item.quality.clippedSamples > 0 && <span role="status">Clipping detected. Record with a lower input level.</span>}
        {item.quality && item.quality.silentFrames / item.quality.frames > 0.9 && <span role="status">Mostly silence. Trim the recording or record it again.</span>}
        <form className="tts-row" onSubmit={event => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          void run(async () => {
            const trimmed = await runtime.execute("trimReference", { owner: OWNER, assetId: item.asset.id, from: Number(data.get("from")), to: Number(data.get("to")), transcript: String(data.get("transcript")).trim() });
            setReferences(items => items.map((reference, position) => position === index ? trimmed : reference));
            setReferenceReload(value => value + 1);
          });
        }}>
          <Field label="Reference trim start"><input name="from" type="number" min={0} max={item.asset.duration} step="any" defaultValue={0} required /></Field>
          <Field label="Reference trim end"><input name="to" type="number" min={0} max={item.asset.duration} step="any" defaultValue={item.asset.duration} required /></Field>
          <Field label="Trimmed transcript"><textarea name="transcript" defaultValue={item.transcript} dir="auto" required /></Field>
          <button disabled={busy}>Trim reference</button>
        </form>
      </li>)}</ul>
      {canBind && references.length > 0 && <button disabled={!permission || !rights.trim()} onClick={() => bindReferences(references.map(item => item.asset.id), rights.trim())}>Assign references</button>}
    </section>
    {fishConfigured && <VoiceWorkflows runtime={runtime} active={active} settings={settings} references={references} rights={rights} permission={permission} busy={busy} run={run} assetUrl={assetUrl} openVoice={voice=>{setLookup(voice);setReload(value=>value+1);}}/>}
    </div></details>
    <details className="tts-advanced"><summary>Voice history</summary><div className="tts-stack">
    {fishConfigured && <VoiceMutationHistory runtime={runtime} active={active} reload={mutationReload} onChanged={()=>{setMutationReload(value=>value+1);setReload(value=>value+1);}} run={run} busy={busy} report={report}/>}
    <VoiceReviewHistory runtime={runtime} active={active} busy={busy} run={run} openProject={openProject}/>
    </div></details>
  </div>;
}
