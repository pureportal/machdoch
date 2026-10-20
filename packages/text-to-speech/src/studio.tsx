import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AudioLines, BookOpen, ChevronDown, FileText, MoreHorizontal, Pause, Play, Redo2, Save, Settings2, SlidersHorizontal, Square, Trash2, Undo2, Users } from "lucide-react";
import {
  DELIVERY_TAGS, compileSpeechScript, speechRenderSegment, createAudioPlaybackHandle,
  speechContentHash, speechPlayback, createSpeechPlayback, orderedProductionTakes,collectSpeechReferenceAssetIds,speechCastBindings,validateSpeechCastStructure,
  type PhonemeAlphabet, type PlaybackState, type SourceRange, type SpeechAsset,
  type SpeechDictionary,
  type SpeechOperations, type SpeechProfile,
   type SpeechRuntime, type SpeechSettings, type SpeechTake, type SpeechCastMember,
} from "@machdoch/speech";
import { SpeechEditor, type SpeechEditorHandle } from "./editor.tsx";
import { SpeechCreativeTools } from "./creative-tools.tsx";
import { SpeechAssistance } from "./assistance.tsx";
import {useScript} from "./use-script.ts";
import {StructuredScript} from "./structured-script.tsx";
import {JobUsage} from "./job-usage.tsx";
import {BatchRender} from "./batch-render.tsx";
import {RevisionHistory} from "./revision-history.tsx";
import {useProductionHistory} from "./use-production-history.ts";
import "./studio.css";

export interface TextToSpeechStudioProps {
  openProjectId?: string | null;
  onProjectOpened?(): void;
  runtime: SpeechRuntime;
  assetUrl(path: string): string;
  onMediaHandoff?(handoff: SpeechOperations["mediaHandoff"]["output"]): void | Promise<void>;
}

type Panel = "script" | "takes" | "timeline" | "voices" | "profiles" | "dictionaries" | "settings";
type VoiceTarget = { kind: "new" } | { kind: "speaker"; id: string };

import {Field,errorText,OWNER,type Run} from "./controls.tsx";
import {useProjects} from "./projects.ts";
import {ProjectLibrary} from "./project-library.tsx";
import {CastEditor} from "./cast.tsx";
import {TakeRow,TakeComparison,TimelineClip} from "./production.tsx";
import {ExportPanel} from "./export-panel.tsx";
import {BackgroundTracks} from "./background-tracks.tsx";
import {insertTimelineSilence} from "./timeline.ts";
import {PlaybackControls} from "./playback-controls.tsx";
import {ReadingPlayer} from "./reading-player.tsx";
import {SceneCasting} from "./scene-casting.tsx";
import {ProductionChecks} from "./production-checks.tsx";
import {VoiceLibrary} from "./voices.tsx";
import {VoiceAuditions} from "./voice-auditions.tsx";
import {ProfilesPanel} from "./profiles.tsx";
import {DictionariesPanel} from "./dictionaries.tsx";
import {SettingsPanel} from "./settings.tsx";
import {TimelineTools} from "./timeline-tools.tsx";
import {TranscriptTiming} from "./transcript-timing.tsx";
import {useTiming} from "./use-timing.ts";
export function TextToSpeechStudio({ runtime, assetUrl, onMediaHandoff, openProjectId, onProjectOpened }: TextToSpeechStudioProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const report = useCallback((value: unknown) => setError(errorText(value)), []);
  const run: Run = useCallback(async task => {
    setPending(count => count + 1);
    setError(null);
    try { await task(); } catch (failure) { report(failure); }
    finally { setPending(count => count - 1); }
  }, [report]);
  const workspace = useProjects(runtime, report);
  const { project, edit, save } = workspace;
  const installOpenedProject = workspace.open;
  useEffect(() => {
    if (!openProjectId) return;
    let disposed = false;
    void run(async () => {
      try {
        await save();
        const item = await runtime.execute("getProject", { id: openProjectId });
        if (!disposed) await installOpenedProject(item);
      } finally { if (!disposed) onProjectOpened?.(); }
    });
    return () => { disposed = true; };
  }, [openProjectId, runtime, save, installOpenedProject, onProjectOpened, run]);
  const [panel, setPanel] = useState<Panel>("script");
  const [profiles, setProfiles] = useState<SpeechProfile[]>([]);
  const [dictionaries, setDictionaries] = useState<SpeechDictionary[]>([]);
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [comparisonIds,setComparisonIds]=useState<string[]>([]);
  const history=useProductionHistory(runtime,project,pollKey,comparisonIds,report);
  const {jobs,setJobs,rawTakes,setTakes,queuePaused,setQueuePaused,pollFailed}=history;
  const timing = useTiming(runtime, project, rawTakes);
  const takes = timing.takes;
  const [historyOpen,setHistoryOpen]=useState(false);
  const [selection, setSelection] = useState<SourceRange>({ from: 0, to: 0 });
  const [mode, setMode] = useState<"source" | "structured">("source");
  const [scope, setScope] = useState<"project" | "chapter" | "scene" | "turn" | "selection">("project");
  const [targetId, setTargetId] = useState("");
  const [takeCount, setTakeCount] = useState(1);
  const [reuseCache, setReuseCache] = useState(true);
  const [alphabet, setAlphabet] = useState<PhonemeAlphabet>("arpabet");
  const [references, setReferences] = useState<SpeechAsset[]>([]);
  const [voiceTarget, setVoiceTarget] = useState<VoiceTarget | null>(null);
  const studio = useRef<HTMLElement>(null);
  const previousPanel = useRef(panel);
  const [playback, setPlayback] = useState<PlaybackState>(() => speechPlayback.snapshot());
  const editor = useRef<SpeechEditorHandle>(null);
  const historyButton=useRef<HTMLButtonElement>(null);
  const projectTitle=useRef<HTMLInputElement>(null);
  const duplicateButton=useRef<HTMLButtonElement>(null);
  const copyFormId=useId();
  const [copyOpen,setCopyOpen]=useState(false);
  const [copyTitle,setCopyTitle]=useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  useEffect(()=>setCopyOpen(false),[project?.id]);
  const busy = pending > 0;
  const profile = profiles.find(item => item.id === project?.profileId);
  const connection = settings?.connections.find(item => item.backend === profile?.backend);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      workspace.loadProjects(),
      runtime.execute("listProfiles", {}),
      runtime.execute("listDictionaries", {}),
      runtime.execute("settings", {}),
    ]).then(([, profileItems, dictionaryItems, configuration]) => {
      if (disposed) return;
      setProfiles(profileItems);
      setDictionaries(dictionaryItems);
      setSettings(configuration);
    }).catch(failure => { if (!disposed) report(failure); });
    return () => { disposed = true; };
  }, [runtime, report, workspace.loadProjects]);

  useEffect(() => speechPlayback.subscribe(setPlayback), []);
  useEffect(() => () => speechPlayback.stop(OWNER), []);

  useEffect(() => {
    setSelection({ from: 0, to: 0 });
    setTargetId("");
    setHistoryOpen(false);
    setVoiceTarget(null);
    setComparisonIds([]);
    setProjectsOpen(false);
  }, [project?.id]);

  useEffect(() => {
    if (previousPanel.current === "voices" && panel === "script") {
      studio.current?.querySelector<HTMLButtonElement>(".tts-choose-voice")?.focus({ preventScroll: true });
    }
    if (panel !== "voices") setVoiceTarget(null);
    previousPanel.current = panel;
  }, [panel]);

  const referenceIds = collectSpeechReferenceAssetIds(project?.cast??[]).sort().join(",");
  useEffect(() => {
    let disposed = false;
    const ids = referenceIds ? referenceIds.split(",") : [];
    void Promise.all(ids.map(id => runtime.execute("asset", { id }))).then(items => {
      if (!disposed) setReferences(items);
    }).catch(failure => { if (!disposed) report(failure); });
    return () => { disposed = true; };
  }, [runtime, referenceIds, report]);

  const compileOptions = useMemo(() => ({
        backend: profile?.backend,
        cast: speechCastBindings(project?.cast??[],id=>references.find(asset=>asset.id===id)?.sha256),
        maxUtf8Bytes: connection?.maxTextBytes ?? undefined,
        maxSpeakers: connection?.maxSpeakers ?? undefined,
        phonemeAlphabet: alphabet,
      }), [project?.cast, references, connection, alphabet, profile?.backend]);
  const analysis = useScript(project?.source ?? "", compileOptions);
  const compiled = analysis.compiled;
  const diagnostics = useMemo(() => [...new Map(compiled.diagnostics.map(item => [item.message, item])).values()], [compiled.diagnostics]);
  const parsed = compiled.script;
  const scenes = parsed.nodes.filter(node => node.kind === "scene" || node.kind === "chapter");
  const targets = analysis.targets;
  const chosenTarget = targets.find(target=>target.id===targetId&&target.kind===scope);
  const renderRange = scope === "selection" ? selection : chosenTarget;
  const targetLabel = scope.charAt(0).toUpperCase()+scope.slice(1);

  const audition = async (id: string, url: string, position = 0) => {
    await speechPlayback.play({
      owner: OWNER, itemId: id,
      open: async signal => {
        const handle = createAudioPlaybackHandle(url, { signal, rate: profile?.playbackRate ?? 1, duration:takes.find(take=>take.id===id)?.asset.duration });
        if (position > 0) handle.seek(position);
        return handle;
      },
    });
  };

  const render = async (preview = false, previewSource?: string) => {
    const stored = await save();
    if (!stored || !settings) throw new Error("Open a project and load settings before rendering.");
    const selectedProfile = profiles.find(item => item.id === stored.profileId);
    if (!selectedProfile) throw new Error("Select a synthesis profile.");
    if (!Number.isSafeInteger(takeCount) || takeCount < 1) throw new Error("Enter a positive whole number of takes.");
    if (previewSource === undefined && scope !== "project" && (!renderRange || renderRange.to <= renderRange.from)) throw new Error("Select text or choose a nonempty render target.");
    validateSpeechCastStructure(stored);
    const assets = await Promise.all(collectSpeechReferenceAssetIds(stored.cast).map(id => runtime.execute("asset", { id })));
    const limits = settings.connections.find(item => item.backend === selectedProfile.backend);
    const result = compileSpeechScript(previewSource ?? stored.source, {
      backend: selectedProfile.backend,
      cast: speechCastBindings(stored.cast,id=>{
          const asset = assets.find(item => item.id === id);
          if (!asset) throw new Error("Reload the missing reference " + id + ".");
          return asset.sha256;
      }),
      selection: previewSource === undefined ? renderRange : undefined, phonemeAlphabet: alphabet,
      maxUtf8Bytes: limits?.maxTextBytes ?? undefined, maxSpeakers: limits?.maxSpeakers ?? undefined,
    });
    if (result.diagnostics.some(item => item.severity === "error")) throw new Error(result.diagnostics.filter(item => item.severity === "error").map(item => item.message).join(" "));
    if (!result.segments.length) throw new Error("Enter spoken text before rendering.");
    const segments = result.segments.map(speechRenderSegment);
    const request = {
      owner: OWNER, projectId: stored.id, revisionId: stored.revisionId, profileId: selectedProfile.id,
      segments, takes: preview ? 1 : takeCount, priority: preview ? 100 : 0, reuseCache: preview || reuseCache,
      cloudConsent: settings.cloudConsent, budgetLimit: settings.budgetLimit,
    };
    if (preview) {
      await speechPlayback.play({owner:OWNER,itemId:`preview:${stored.id}`,open:signal => createSpeechPlayback(runtime,request,signal,{assetUrl,rate:selectedProfile.playbackRate,onCancellationFailure:report})});
    } else await runtime.execute("render",request);
    setPollKey(value => value + 1);
    setPanel("takes");
  };

  const openProject = async (id: string) => {
    await save();
    await workspace.open(await runtime.execute("getProject", { id }));
    setPanel("script");
  };

  const addClip = (take: SpeechTake, range?: { from: number; to: number }) => {
    if (!(take.asset.duration > 0)) throw new Error("This take has no measured duration. Choose another take.");
    edit(value => ({
      ...value, timeline: [...value.timeline, {
        id: crypto.randomUUID(), takeId: take.id,
        start: Math.max(0, ...value.timeline.map(clip => clip.start + clip.out - clip.in)),
        in: range?.from ?? 0, out: range?.to ?? take.asset.duration, gain: 1, fadeIn: 0, fadeOut: 0, track: 0,
      }],
    }));
    setPanel("timeline");
  };

  const currentPlayback = playback.owner === OWNER;
  const binding = voiceTarget?.kind === "speaker" ? project?.cast.find(member => member.id === voiceTarget.id) : undefined;
  const canBindVoice = !!project && (voiceTarget?.kind === "new" || !!binding);
  const assignVoice = (voice: Pick<SpeechCastMember, "voiceId" | "referenceAssetIds" | "rightsEvidence">) => {
    if (!canBindVoice) return;
    edit(value => ({ ...value, cast: voiceTarget?.kind === "new"
      ? [...value.cast, { id: crypto.randomUUID(), name: value.cast.length ? `Speaker ${value.cast.length + 1}` : "Narrator", direction: "", ...voice }]
      : value.cast.map(member => member.id === binding?.id ? { ...member, ...voice } : member),
    }));
    setPanel("script");
  };
  const primaryPanels = [
    { id: "script", label: "Script", icon: FileText },
    { id: "voices", label: "Voices", icon: Users },
    { id: "takes", label: "Takes", icon: AudioLines },
    { id: "timeline", label: "Export", icon: BookOpen },
  ] as const;
  const renderReason = !project ? "Open a project to render." : analysis.error ? analysis.error : !analysis.ready ? "Analyzing script…" : !profile ? "Select a synthesis profile." :
    !settings ? "Load settings to render." : !connection?.configured ? "Configure the selected provider in Settings." :
    !["sglang", "drama3"].includes(profile.backend) && !settings.cloudConsent ? "Allow cloud processing in Settings to use this provider." : null;
  const canGenerate = !busy && !workspace.conflict && !renderReason && !!project?.source.trim() && !compiled.diagnostics.some(item => item.severity === "error");

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      document.querySelectorAll<HTMLDetailsElement>(".tts-menu[open]").forEach(menu => {
        if (!menu.contains(event.target as Element)) menu.open = false;
      });
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);

  return <section ref={studio} className="tts-studio" aria-label="Text to Speech" onKeyDown={event => {
    if (event.key !== "Escape" || !(event.target instanceof Element)) return;
    const menu = event.target.closest<HTMLDetailsElement>(".tts-menu[open]");
    if (menu) { event.preventDefault(); menu.open = false; menu.querySelector("summary")?.focus(); }
  }} onClick={event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    const menu = button?.closest<HTMLDetailsElement>(".tts-menu");
    if (menu && !button?.disabled) menu.open = false;
  }}>
    <header className="tts-header">
      <div className="tts-row"><AudioLines size={22} aria-hidden="true" /><h1>Text to Speech</h1></div>
      <div className="tts-row">
        {project && <button className="tts-project-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(value => !value)}>Projects<ChevronDown size={15} /></button>}
        {project && <><span className="tts-save-state" role="status">{workspace.saveState}</span><button disabled={busy || !!workspace.conflict || workspace.saveState === "Saved"} onClick={() => void run(save)}><Save size={16} />Save</button></>}
      </div>
    </header>
    {error && <div className="tts-error" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    {workspace.conflict && <div className="tts-conflict" role="alert">
      <span>This project changed elsewhere.</span>
      <button disabled={busy} onClick={() => void run(async () => {
        if (!window.confirm("Discard your local edits and reload the saved project?")) return;
        if (project) await workspace.accept(await runtime.execute("getProject", { id: project.id }));
      })}>Discard local edits</button>
      <button disabled={busy} onClick={() => void run(async () => {
        const local = workspace.current.current;
        if (!local) return;
        const now = new Date().toISOString();
        const copy = await runtime.execute("saveProject", {
          project: { ...local, id: crypto.randomUUID(), title: local.title + " (copy)", revisionId: crypto.randomUUID(), parentRevisionId: null, createdAt: now, updatedAt: now },
          expectedRevisionId: null,
        });
        await workspace.accept(copy);
        await workspace.loadProjects({offset:0});
      })}>Save as copy</button>
    </div>}
    {workspace.recovery.length > 0 && <section className="tts-conflict" aria-label="Recovered drafts">
      {workspace.recovery.map(draft => <div key={draft.id} className="tts-row">
        <span>Unsaved draft · {new Date(draft.savedAt).toLocaleString()}</span>
        <button disabled={busy || !!workspace.conflict} onClick={() => void run(async () => {
          if (workspace.saveState !== "Saved" && !window.confirm("Replace your current edits with this recovered draft?")) return;
          await workspace.recover(draft);
        })}>Restore draft</button>
        <button disabled={busy} onClick={() => void run(async () => {
          if (window.confirm("Permanently delete this unsaved draft?")) await workspace.discardRecovery(draft.id);
        })}>Delete draft</button>
      </div>)}
    </section>}
    <div className="tts-layout" data-projects-open={projectsOpen || !project} data-has-project={!!project} data-panel={panel}>
      <ProjectLibrary runtime={runtime} workspace={workspace} run={run} busy={busy} openProject={openProject} onCreated={() => setPanel("script")} />
      <main className="tts-main">
        <nav className="tts-tabs" aria-label="Studio">
          {primaryPanels.map(({ id, label, icon: Icon }) => <button key={id} disabled={!project && (id === "takes" || id === "timeline")} aria-current={panel === id ? "page" : undefined} onClick={() => setPanel(id)}><Icon size={16} aria-hidden="true" />{label}</button>)}
          <details className="tts-menu tts-tools-menu" data-active={panel === "profiles" || panel === "dictionaries"}>
            <summary aria-label="More tools"><SlidersHorizontal size={16} /><span>{panel === "profiles" ? "Profiles" : panel === "dictionaries" ? "Dictionaries" : "More"}</span><ChevronDown size={14} /></summary>
            <div className="tts-menu-content">
              {(["profiles", "dictionaries"] as const).map(item => <button key={item} aria-current={panel === item ? "page" : undefined} onClick={event => {
                setPanel(item);
                const menu = event.currentTarget.closest("details");
                if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
              }}>{item === "profiles" ? "Profiles" : "Dictionaries"}</button>)}
            </div>
          </details>
          <button className="tts-icon-button" aria-label="Settings" aria-current={panel === "settings" ? "page" : undefined} onClick={() => setPanel("settings")}><Settings2 size={18} /></button>
        </nav>
        {project && <div className="tts-project-bar">
          <Field label="Title"><input ref={projectTitle} value={project.title} required onChange={event => edit(value => ({ ...value, title: event.target.value }))} /></Field>
          <details className="tts-menu tts-project-actions"><summary aria-label="Project actions"><MoreHorizontal size={20} /></summary><div className="tts-menu-content">
          <button ref={historyButton} disabled={busy || !!workspace.conflict} onClick={() => void run(async () => {
            const stored = await save();
            if (stored) setHistoryOpen(true);
          })}>History</button>
          <button disabled={busy || !!workspace.conflict} onClick={() => void run(async () => { edit(value => ({ ...value, archived: !value.archived })); await save();await workspace.loadProjects({offset:0}); })}>{project.archived ? "Unarchive" : "Archive"}</button>
          <button ref={duplicateButton} aria-expanded={copyOpen} aria-controls={copyOpen?copyFormId:undefined} disabled={busy || !!workspace.conflict} onClick={() => {
            if (!copyOpen) setCopyTitle(`${project.title} copy`);
            setCopyOpen(value=>!value);
          }}>Duplicate</button>
          <button className="tts-danger" disabled={busy || !!workspace.conflict} onClick={() => void run(async () => {
            if (!window.confirm("Delete “" + project.title + "” and its saved project data?")) return;
            await save();
            await runtime.execute("deleteProject", { id: project.id });
            workspace.install(null);
            await workspace.loadProjects({offset:0});
          })}><Trash2 size={16} />Delete</button>
          </div></details>
          {copyOpen&&<form id={copyFormId} className="tts-row tts-copy-form" aria-label="Copy project" onSubmit={event=>{
            event.preventDefault();
            void run(async()=>{await workspace.duplicate(copyTitle);setCopyOpen(false);setPanel("script");projectTitle.current?.focus();});
          }}>
            <Field label="Copy name"><input autoFocus required maxLength={1024} disabled={busy} value={copyTitle} onChange={event=>setCopyTitle(event.target.value)}/></Field>
            <button disabled={busy||!copyTitle.trim()}>Create copy</button>
            <button type="button" disabled={busy} onClick={()=>{setCopyOpen(false);duplicateButton.current?.closest("details")?.querySelector("summary")?.focus();}}>Cancel</button>
          </form>}
        </div>}
        {historyOpen&&project&&<RevisionHistory runtime={runtime} project={project} save={save} restore={async value=>{workspace.install(value);await workspace.loadProjects({offset:0});}} run={run} busy={busy||!!workspace.conflict} close={()=>{setHistoryOpen(false);historyButton.current?.closest("details")?.querySelector("summary")?.focus();}}/>}
        <div hidden={panel !== "script"} className="tts-panel tts-script-panel">
          {!project ? <div className="tts-empty"><AudioLines size={36} strokeWidth={1.3} aria-hidden="true" /><h2>Open a project or create one to start.</h2></div> : <>
            <div className="tts-script-layout">
            <div className="tts-writing">
            <div className="tts-section-heading"><h2>Script</h2><span className="tts-muted">{parsed.characters.toLocaleString()} characters</span></div>
            <div hidden={mode !== "source"}>
              <div className="tts-toolbar">
                <button aria-label="Undo script edit" onClick={() => editor.current?.undo()}><Undo2 size={16} /></button>
                <button aria-label="Redo script edit" onClick={() => editor.current?.redo()}><Redo2 size={16} /></button>
                <select aria-label="Wrap selection with delivery tag" value="" onChange={event => editor.current?.wrap(event.target.value as typeof DELIVERY_TAGS[number])}>
                  <option value="" disabled>Delivery</option>{DELIVERY_TAGS.map(tag => <option key={tag}>{tag}</option>)}
                </select>
                {project.cast.length > 1 && <select aria-label="Insert speaker" value="" onChange={event => editor.current?.insert("<|speaker:" + event.target.value + "|>")}>
                  <option value="" disabled>Speaker</option>{project.cast.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>}
                <details className="tts-menu"><summary>Insert<ChevronDown size={14} /></summary><div className="tts-menu-content">
                <button onClick={() => editor.current?.insert("[]")}>Direction</button>
                <button onClick={() => editor.current?.insert("<|phoneme_start|><|phoneme_end|>")}>Phoneme</button>
                <button onClick={() => editor.current?.insert("\n# \n")}>Chapter</button>
                <button onClick={() => editor.current?.insert("\n## \n")}>Scene</button>
                <button onClick={() => editor.current?.insert("<!--  -->")}>Comment</button>
                </div></details>
                <details className="tts-menu tts-editor-options"><summary aria-label="Editor options"><Settings2 size={16} /></summary><div className="tts-menu-content tts-stack">
                  <Field label="Editor mode"><select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="source">Source</option><option value="structured">Structured</option></select></Field>
                  <Field label="Phonemes"><select value={alphabet} onChange={event => setAlphabet(event.target.value as PhonemeAlphabet)}>
                    <option value="arpabet">ARPAbet</option><option value="pinyin">Pinyin</option><option value="romaji">Romaji</option>
                  </select></Field>
                </div></details>
              </div>
              <SpeechEditor key={project.id} ref={editor} source={project.source} script={analysis.ready ? parsed : undefined} speakers={project.cast} diagnostics={analysis.ready ? compiled.diagnostics : []}
                onSelection={setSelection} onChange={source => edit(value => ({ ...value, source }))} />
            </div>
            {mode === "structured" && <><div className="tts-row"><button onClick={() => setMode("source")}>Source</button></div><StructuredScript key={project.id} script={parsed} source={project.source} onChange={source => edit(value => ({...value, source}))} /></>}
            {!!diagnostics.length && <ul className="tts-diagnostics">
              {diagnostics.map((item, index) => <li key={index}><button onClick={() => {
                setMode("source");
                window.requestAnimationFrame(() => editor.current?.focusRange(item));
              }}>{item.message}</button></li>)}
            </ul>}
            </div>
            <aside className="tts-generation" aria-label="Voice setup">
            <section className="tts-voice-setup tts-stack">
              <div className="tts-section-heading"><h2>Voice setup</h2><button className="tts-icon-button" aria-label="Edit profiles" onClick={() => setPanel("profiles")}><Settings2 size={16} /></button></div>
              <Field label="Profile"><select value={project.profileId ?? ""} onChange={event => edit(value => ({ ...value, profileId: event.target.value || null }))}>
                <option value="">Select profile</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></Field>
              {!profiles.length && <button onClick={() => setPanel("profiles")}>Create profile</button>}
            </section>
            <CastEditor project={project} edit={edit} profile={profile} runtime={runtime} report={report} chooseVoice={id => { setVoiceTarget(id ? { kind: "speaker", id } : { kind: "new" }); setPanel("voices"); }} />
            </aside>
            <div className="tts-render">
              <div className="tts-render-actions">
                <button className="tts-primary" disabled={!canGenerate} onClick={() => void run(() => render())}><AudioLines size={16} />Generate audio</button>
                <button disabled={!canGenerate} onClick={() => void run(() => render(true))}><Play size={16} />Preview</button>
              </div>
              <details className="tts-render-options"><summary>Generation options<ChevronDown size={14} /></summary><div className="tts-grid">
              <Field label="Render"><select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
                <option value="project">Project</option><option value="chapter">Chapter</option><option value="scene">Scene</option><option value="turn">Turn</option><option value="selection">Selection</option>
              </select></Field>
              {scope !== "project" && scope !== "selection" && <Field label={targetLabel}><select value={chosenTarget?.id??""} onChange={event => setTargetId(event.target.value)}>
                <option value="">Choose {scope}</option>{targets.filter(target=>target.kind===scope).map(target => <option key={target.id} value={target.id}>{target.title}</option>)}
              </select></Field>}
              <Field label="Takes"><input type="number" min={1} step={1} required value={takeCount} onChange={event => setTakeCount(event.target.valueAsNumber)} /></Field>
              <label className="tts-check"><input type="checkbox" checked={reuseCache} onChange={event => setReuseCache(event.target.checked)} />Reuse cache</label>
              </div></details>
              {renderReason && <div className="tts-setup-action"><span>{renderReason}</span>{profile && settings && (!connection?.configured || !["sglang", "drama3"].includes(profile.backend) && !settings.cloudConsent) ? <button onClick={() => setPanel("settings")}>Open settings</button> : null}</div>}
            </div>
            <details className="tts-advanced tts-script-advanced"><summary>Advanced tools<ChevronDown size={16} /></summary><div className="tts-stack">
            <SceneCasting project={project} scopes={scenes} edit={edit} report={report}/>
            <SpeechAssistance runtime={runtime} project={project} targets={targets} busy={busy||!analysis.ready||!!workspace.conflict} run={run} report={report} onApply={async (next, rules) => {
              if (rules.length) {
                const target = profiles.find(value => value.id === next.profileId);
                if (!target) throw new Error("Choose a saved speech profile before applying pronunciation rules.");
                const dictionary = await runtime.execute("saveDictionary", { dictionary: { id: crypto.randomUUID(), name: next.title, revision: "", rules: rules.map(rule => ({ ...rule, id: crypto.randomUUID() })) } });
                setDictionaries(items => [dictionary, ...items]);
                const updated = await runtime.execute("saveProfile", { profile: { ...target, dictionaryIds: [...target.dictionaryIds, dictionary.id] } });
                setProfiles(items => items.map(item => item.id === updated.id ? updated : item));
              }
              edit(() => next);
            }} />
            <SpeechCreativeTools runtime={runtime} project={project} sentences={analysis.ready ? analysis.sentences : []} onChange={value => edit(() => value)} onPreview={source => render(true,source)}
              onJump={offset => { setMode("source");window.requestAnimationFrame(() => editor.current?.focusRange({from:offset,to:offset})); }} />
            <BatchRender runtime={runtime} project={project} profiles={profiles} dictionaries={dictionaries} settings={settings} run={run} busy={busy||!!workspace.conflict} onProjects={()=>workspace.loadProjects({offset:0})} openProject={openProject}/>
            </div></details>
            </div>
          </>}
        </div>
        <div hidden={panel !== "takes"} className="tts-panel">
          {!project ? <p>Open a project to view takes.</p> : <>
            <div className="tts-section-heading"><h2>Audio takes</h2>
            <details className="tts-menu"><summary>Queue controls<ChevronDown size={14} /></summary><div className="tts-menu-content tts-stack"><button onClick={() => setPollKey(value => value + 1)}>{pollFailed ? "Retry loading jobs" : "Refresh jobs"}</button>
              <button disabled={busy} onClick={() => void run(async () => setQueuePaused((await runtime.execute("queue", { paused: !queuePaused })).paused))}>{queuePaused ? "Resume queue" : "Pause queue"}</button>
              <label className="tts-check"><input type="checkbox" checked={history.activeOnly} onChange={event=>history.showActive(event.target.checked)}/>Active jobs only</label>
              <button disabled={busy || !jobs.some(job => (job.state === "queued" || job.state === "running")&&!job.cancelRequestedAt)} onClick={() => void run(history.cancelAll)}>Cancel all jobs</button>
              {history.moreActive&&!history.activeOnly&&<button onClick={()=>history.showActive(true)}>More active jobs</button>}
            </div></details></div>
            {(history.jobPage>0||history.moreJobs)&&<nav className="tts-row" aria-label="Job pages"><button disabled={history.loading||history.jobPage===0} onClick={()=>history.setJobPage(value=>value-1)}>Previous jobs</button><span>Page {history.jobPage+1}</span><button disabled={history.loading||!history.moreJobs} onClick={()=>history.setJobPage(value=>value+1)}>Next jobs</button></nav>}
            {!!jobs.length && <details className="tts-job-history" open={jobs.some(job => job.state !== "completed") ? true : undefined}><summary>Generation jobs · {jobs.length}</summary><ul className="tts-jobs">{jobs.map(job => <li key={job.id}>
              <span>{job.kind==="alignment"?"Word timing · ":""}{job.state==="running"&&job.cancelRequestedAt?"Cancelling":job.state} · {job.completedSegments}/{job.totalSegments}</span>
              {job.error && <span role="alert">{job.error}</span>}
              <JobUsage usage={job.usage}/>
              {["failed", "cancelled", "uncertain", "interrupted"].includes(job.state) && <button disabled={busy} onClick={() => void run(async () => {
                if (job.state === "uncertain" && !window.confirm("Retry this uncertain request? The provider may charge for both attempts.")) return;
                const attempt = await runtime.execute("retry", { jobId: job.id, owner: job.owner, confirmedUncertain: job.state === "uncertain" });
                setJobs(items => [attempt, ...items]);
              })}>Retry job</button>}
              {(job.state === "queued" || job.state === "running") && <button disabled={busy||!!job.cancelRequestedAt} onClick={() => void run(async () => {
                const cancelled = await runtime.execute("cancel", { jobId: job.id, owner: job.owner });
                setJobs(items => items.map(item => item.id === job.id ? cancelled : item));
              })}>Cancel job</button>}
            </li>)}</ul></details>}
            {!takes.length && <div className="tts-empty"><AudioLines size={32} aria-hidden="true" /><h2>{jobs.some(job => job.state === "running" || job.state === "queued") ? "Audio is being generated…" : "No audio takes yet."}</h2><button onClick={() => setPanel("script")}>Back to script</button></div>}
            {takes.length > 0 && <><ReadingPlayer key={`reading:${project.id}`} project={project} takes={takes} segments={compiled.segments.map(segment=>segment.id)} ready={analysis.ready} visible={panel==="takes"} assetUrl={assetUrl} run={run} busy={busy} rate={profile?.playbackRate??1} onReadingBookmarksChange={bookmarks=>edit(value=>({...value,readingBookmarks:bookmarks}))}/>
            <details className="tts-advanced"><summary>Review tools</summary><div className="tts-stack">
            <ProductionChecks project={project} takes={takes} segments={compiled.segments} runtime={runtime} ready={analysis.ready} busy={busy} run={run} onSeek={(take,seconds)=>audition(take.id,assetUrl(take.asset.path),seconds)}/>
            {timing.error && <div role="alert">{timing.error}<button onClick={timing.reload}>Reload word timing</button></div>}
            <TranscriptTiming key={`timing:${project.id}`} runtime={runtime} takes={rawTakes} jobs={jobs} settings={settings} selections={project.timingSelections??{}} busy={busy||!!workspace.conflict} run={run} report={report}
              onQueued={()=>setPollKey(value=>value+1)} onSeek={(take,seconds)=>audition(take.id,assetUrl(take.asset.path),seconds)}
              onApply={async(takeId,timingId)=>{const id=project.id;edit(value=>{if(value.id!==id)throw new Error("Reopen the timing project before saving.");const timingSelections={...value.timingSelections};if(timingId)timingSelections[takeId]=timingId;else delete timingSelections[takeId];return {...value,timingSelections};});const stored=await save();if(stored?.id!==id)throw new Error("The timing project changed. Reopen it before retrying.");}}/>
            <TakeComparison key={`comparison:${project.id}`} takes={takes.filter(take=>history.visibleTakeIds.has(take.id)||comparisonIds.includes(take.id))} onSelectionChange={setComparisonIds} playback={playback} audition={(take, position) => audition(take.id, assetUrl(take.asset.path), position)} run={run} />
            </div></details></>}
            {(history.takePage>0||history.moreTakes)&&<nav className="tts-row" aria-label="Take pages"><button disabled={history.loading||history.takePage===0} onClick={()=>history.setTakePage(value=>value-1)}>Previous takes</button><span>Page {history.takePage+1}</span><button disabled={history.loading||!history.moreTakes} onClick={()=>history.setTakePage(value=>value+1)}>Next takes</button></nav>}
            <div className="tts-take-list">{takes.filter(take=>history.visibleTakeIds.has(take.id)).map(take => <TakeRow key={take.id} take={take}
              selected={project.selectedTakes[take.segmentId] === take.id} busy={busy}
              audition={() => audition(take.id, assetUrl(take.asset.path))}
              update={async changes => {
                const result = await runtime.execute("updateTake", { id: take.id, ...changes });
                setTakes(items => items.map(item => item.id === result.id ? result : item));
              }}
              select={() => edit(value => ({ ...value, selectedTakes: { ...value.selectedTakes, [take.segmentId]: take.id } }))}
              addClip={range => addClip(take,range)} run={run} runtime={runtime} settings={settings} onQueued={()=>setPollKey(value=>value+1)}
              seek={seconds => audition(take.id,assetUrl(take.asset.path),seconds)}
              handoff={onMediaHandoff ? async () => { await save(); await onMediaHandoff(await runtime.execute("mediaHandoff", { projectId: project.id, takeId: take.id })); } : undefined}
            />)}</div>
          </>}
        </div>
        <div hidden={panel !== "timeline"} className="tts-panel">
          {!project ? <p>Open a project to edit the timeline.</p> : <>
            <div className="tts-production-layout">
            <ExportPanel project={project} takes={takes} compiled={compiled} segments={compiled.segments.map(segment=>segment.id)} analysisReady={analysis.ready} runtime={runtime} save={save} changeSettings={exportSettings=>edit(value=>({...value,exportSettings}))} run={run} busy={busy} assetUrl={assetUrl} audition={audition}/>
            <section className="tts-timeline-panel tts-stack">
            <h2>Timeline</h2>
            <button disabled={busy||!analysis.ready||!Object.keys(project.selectedTakes).length} onClick={()=>void run(async()=>{
              if(project.timeline.length&&!window.confirm("Replace speech clips with the selected production takes?"))return;
              const ordered=orderedProductionTakes(project,takes,compiled.segments.map(segment=>segment.id),true);
              if(!ordered.length)throw new Error("Select production takes before assembling the timeline.");
              let start=0;
              const timeline=ordered.map(take=>{const clip={id:crypto.randomUUID(),takeId:take.id,start,in:0,out:take.asset.duration,gain:1,fadeIn:0,fadeOut:0,track:0};start+=take.asset.duration;return clip;});
              edit(value=>({...value,timeline}));
            })}>Assemble selected takes</button>
            {!!project.timeline.length && <TimelineTools clips={project.timeline} takes={takes} change={timeline=>edit(value=>({...value,timeline}))} report={report}
              insertSilence={(position,duration)=>edit(value=>({...value,timeline:insertTimelineSilence(value.timeline,position,duration,()=>crypto.randomUUID()),backgroundTracks:insertTimelineSilence(value.backgroundTracks??[],position,duration,()=>crypto.randomUUID())}))}/>}
            {project.timeline.map(clip => <TimelineClip key={clip.id} clip={clip} take={takes.find(take => take.id === clip.takeId)} report={report}
              save={value => edit(item => ({ ...item, timeline: item.timeline.map(current => current.id === value.id ? value : current) }))}
              remove={() => edit(value => ({ ...value, timeline: value.timeline.filter(item => item.id !== clip.id) }))} />)}
            {!project.timeline.length && <div className="tts-timeline-empty"><p className="tts-muted">No clips yet.</p><button onClick={() => setPanel("takes")}>Choose audio takes</button></div>}
            <details className="tts-advanced"><summary>Background audio</summary><BackgroundTracks project={project} runtime={runtime} change={update=>edit(value=>({...value,backgroundTracks:update(value.backgroundTracks??[])}))} run={run} busy={busy} assetUrl={assetUrl} audition={audition} report={report}/></details>
            </section>
            </div>
          </>}
        </div>
        <div hidden={panel !== "voices"} className="tts-panel">
          {canBindVoice && <div className="tts-voice-selection tts-row"><button onClick={() => setPanel("script")}>Back to script</button><span>Choose a voice for {binding?.name || (project?.cast.length ? "new speaker" : "Narrator")}</span></div>}
          {!!project?.cast.length && voiceTarget?.kind !== "new" && (!binding || project.cast.length > 1) && <Field label="Assign to"><select value={binding?.id ?? ""} onChange={event => setVoiceTarget(event.target.value ? { kind: "speaker", id: event.target.value } : null)}>
            <option value="">Choose cast member</option>{project.cast.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select></Field>}
          <VoiceLibrary runtime={runtime} active={panel === "voices"} settings={settings} profiles={profiles} run={run} busy={busy} report={report}
            audition={audition} assetUrl={assetUrl} openProject={openProject} canBind={canBindVoice}
            bindVoice={voiceId => assignVoice({ voiceId, referenceAssetIds: [], rightsEvidence: undefined })}
            bindReferences={(referenceAssetIds, rightsEvidence) => assignVoice({ voiceId: undefined, referenceAssetIds, rightsEvidence })}
          />
          {project&&<details className="tts-advanced"><summary>Listening reviews</summary><VoiceAuditions key={project.id} runtime={runtime} takes={takes} reviews={project.voiceAuditions??[]} onSave={async voiceAuditions=>{const id=project.id;edit(value=>{if(value.id!==id)throw new Error("Reopen the reviewed project before saving.");return {...value,voiceAuditions};});const saved=await save();if(saved?.id!==id)throw new Error("The review project changed. Reopen it before retrying.");}} onListen={async take=>{await audition(take.id,assetUrl(take.asset.path));const state=speechPlayback.snapshot();if(state.itemId!==take.id||state.status!=="playing")throw new Error(state.error??"Press Play to start this take before reviewing it.");}}/></details>}
        </div>
        <div hidden={panel !== "profiles"} className="tts-panel">
          <ProfilesPanel runtime={runtime} profiles={profiles} dictionaries={dictionaries} settings={settings} run={run} busy={busy}
            playReference={asset=>audition(`profile-reference:${asset.id}`,assetUrl(asset.path))}
            saved={item => { setProfiles(items => [item, ...items.filter(current => current.id !== item.id)]); if (project && !project.profileId) { edit(value => ({ ...value, profileId: item.id })); setPanel("script"); } }}
            deleted={id => { setProfiles(items => items.filter(item => item.id !== id)); if (project?.profileId === id) edit(value => ({ ...value, profileId: null })); }} />
        </div>
        <div hidden={panel !== "dictionaries"} className="tts-panel">
          <DictionariesPanel runtime={runtime} dictionaries={dictionaries} profiles={profiles} settings={settings} assetUrl={assetUrl} run={run} busy={busy}
            saved={item => setDictionaries(items => [item, ...items.filter(current => current.id !== item.id)])} />
        </div>
        <div hidden={panel !== "settings"} className="tts-panel">
          {settings ? <SettingsPanel runtime={runtime} settings={settings} saved={setSettings} run={run} busy={busy} /> :
            <button disabled={busy} onClick={() => void run(async () => setSettings(await runtime.execute("settings", {})))}>Load settings</button>}
        </div>
      </main>
    </div>
    {currentPlayback && <footer className="tts-player" aria-label="Playback">
      <button aria-label={playback.status === "playing" ? "Pause audio" : "Play audio"} onClick={() => {
        if (playback.status === "playing") speechPlayback.pause(); else void speechPlayback.resume();
      }}>{playback.status === "playing" ? <Pause size={18} /> : <Play size={18} />}</button>
      <button aria-label="Stop audio" onClick={() => speechPlayback.stop(OWNER)}><Square size={16} /></button>
      <input aria-label="Playback position" type="range" min={playback.loop?.start??0} max={playback.loop?playback.loop.end-Math.min(0.01,(playback.loop.end-playback.loop.start)/2):playback.duration ?? playback.position} step={0.01} value={playback.position} disabled={!playback.seekable}
        onChange={event => {try{speechPlayback.seek(event.target.valueAsNumber);}catch(error){report(error);}}} />
      <output>{playback.position.toFixed(1)}{playback.duration !== null ? " / " + playback.duration.toFixed(1) + " s" : " s"}</output>
      <PlaybackControls state={playback} report={report}/>
      {playback.error && <span role="alert">{playback.error}</span>}
    </footer>}
  </section>;
}
