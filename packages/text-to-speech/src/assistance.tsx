import { useEffect, useRef, useState } from "react";
import { applySpeechAssistance, speechProposalDiff, validateSpeechAssistance, type SourceRange, type SpeechRenderTarget, type SpeechAssistanceInput, type SpeechAssistanceProposal, type SpeechProject, type SpeechRuntime } from "@machdoch/speech";
import { Field, OWNER, type Run } from "./controls.tsx";

export function SpeechAssistance({ runtime, project, targets, busy, run, report, onApply }: {
  runtime: SpeechRuntime; project: SpeechProject; targets:SpeechRenderTarget[];busy: boolean; run: Run; report(error: unknown): void;
  onApply(project: SpeechProject, rules: SpeechAssistanceProposal["rules"]): Promise<void>;
}) {
  const [action, setAction] = useState<SpeechAssistanceInput["action"]>("direction");
  const [instruction, setInstruction] = useState("");
  const [language, setLanguage] = useState("");
  const [scope,setScope]=useState<"project"|SpeechRenderTarget["kind"]>("project");
  const [targetId,setTargetId]=useState("");
  const target=scope==="project"?undefined:targets.find(target=>target.id===targetId&&target.kind===scope);
  const source=scope==="project"?project.source:target?project.source.slice(target.from,target.to):"";
  const [proposal, setProposal] = useState<{ input: SpeechAssistanceInput; value: SpeechAssistanceProposal; base: string; range?:SourceRange } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const active = useRef<{ id: string; abandoned: boolean } | null>(null);
  const current = useRef(project);
  current.current = project;
  const identity = (value: SpeechProject): string => JSON.stringify([value.id, value.source, value.cast, value.profileId]);
  useEffect(() => {
    setProposal(null);
    setScope("project");setTargetId("");
    return () => {
      const task = active.current;
      if (task) { task.abandoned = true; void runtime.execute("cancelAssistance", { owner: OWNER, taskId: task.id }).catch(report); }
    };
  }, [project.id, runtime, report]);
  const difference = proposal ? speechProposalDiff(proposal.input.source, proposal.value.source) : null;
  const stale = proposal !== null && proposal.base !== identity(project);
  return <details className="tts-stack">
    <summary>AI assistance</summary>
    <Field label="Action"><select value={action} disabled={busy||taskId!==null} onChange={event => { setAction(event.target.value as typeof action); setProposal(null); }}>
      <option value="direction">Direction</option><option value="casting">Casting</option><option value="pronunciation">Pronunciation</option><option value="localization">Localization</option>
    </select></Field>
    <Field label="Target"><select value={scope} disabled={busy||taskId!==null} onChange={event=>{setScope(event.target.value as typeof scope);setTargetId("");setProposal(null);}}>
      <option value="project">Project</option><option value="chapter">Chapter</option><option value="scene">Scene</option><option value="turn">Turn</option>
    </select></Field>
    {scope!=="project"&&<Field label={scope.charAt(0).toUpperCase()+scope.slice(1)}><select value={target?.id??""} disabled={busy||taskId!==null} onChange={event=>{setTargetId(event.target.value);setProposal(null);}}>
      <option value="">Choose {scope}</option>{targets.filter(target=>target.kind===scope).map(target=><option key={target.id} value={target.id}>{target.title}</option>)}
    </select></Field>}
    {action === "localization" && <Field label="Language code"><input value={language} maxLength={128} disabled={busy||taskId!==null} onChange={event => {setLanguage(event.target.value);setProposal(null);}} required /></Field>}
    <Field label="Direction"><textarea value={instruction} disabled={busy||taskId!==null} onChange={event => {setInstruction(event.target.value);setProposal(null);}} required /></Field>
    <button type="button" disabled={busy || !instruction.trim() || !source.trim() || (action === "localization" && !language.trim())} onClick={() => void run(async () => {
      if (new TextEncoder().encode(source).byteLength > 65_536) throw new Error("Choose a chapter, scene or turn below 64 KiB for one assistance request.");
      const task = { id: crypto.randomUUID(), abandoned: false };
      active.current = task; setTaskId(task.id); setProposal(null);
      const base = identity(project);
      const range=target?{from:target.from,to:target.to}:undefined;
      try {
        const voices = action === "casting" ? (await runtime.execute("listVoices", { page: 1, pageSize: 100 })).voices.map(({ id, name, languages }) => ({ id, name, languages })) : [];
        if (task.abandoned) return;
        const input: SpeechAssistanceInput = { owner: OWNER, taskId: task.id, action, source, instruction: instruction.trim(), ...(action === "localization" ? { language: Intl.getCanonicalLocales(language.trim())[0]! } : {}), cast: project.cast, voices };
        const value = validateSpeechAssistance(await runtime.execute("assist", input), input);
        if (!task.abandoned && identity(current.current) === base) setProposal({ input, value, base, ...(range?{range}:{}) });
      } finally { if (active.current === task) { active.current = null; setTaskId(null); } }
    })}>Suggest changes</button>
    {taskId && <button type="button" onClick={() => void run(async () => {
      if (active.current) active.current.abandoned = true;
      await runtime.execute("cancelAssistance", { owner: OWNER, taskId });
    })}>Cancel assistance</button>}
    {proposal && difference && <>
      <pre aria-label="Script changes" dir="auto">{difference.unchanged}{difference.removed && <del>{difference.removed}</del>}{difference.added && <ins>{difference.added}</ins>}{difference.trailing}</pre>
      <table><caption>Project cast</caption><thead><tr><th>Speaker</th><th>Current direction</th><th>Suggested direction</th><th>Current voice</th><th>Suggested voice</th></tr></thead>
        <tbody>{proposal.value.cast.map(member => {
          const previous = project.cast.find(value => value.id === member.id);
          return <tr key={member.id}><th>{previous?.name}</th><td>{previous?.direction}</td><td>{member.direction}</td><td>{previous?.voiceId}</td><td>{member.voiceId}</td></tr>;
        })}</tbody>
      </table>
      {proposal.value.rules.length > 0 && <table><thead><tr><th>Word</th><th>Pronunciation</th><th>Alphabet</th></tr></thead><tbody>{proposal.value.rules.map((rule, index) => <tr key={index}><th>{rule.text}</th><td>{rule.phonemes}</td><td>{rule.alphabet}</td></tr>)}</tbody></table>}
      {stale && <p role="status">The script changed. Generate a new proposal.</p>}
      <button type="button" disabled={busy || stale || (proposal.value.rules.length > 0 && !project.profileId)} onClick={() => void run(async () => {
        if (proposal.base !== identity(current.current)) throw new Error("The script changed. Generate a new proposal.");
        const next=applySpeechAssistance(project,proposal.input,proposal.value,proposal.range);
        await onApply(next, proposal.value.rules); setProposal(null);
      })}>{proposal.input.action === "localization" ? "Add language variant" : proposal.value.rules.length ? "Add rules to profile" : "Apply changes"}</button>
      {proposal.value.rules.length > 0 && !project.profileId && <p>Choose a profile before applying pronunciation rules.</p>}
      <button type="button" disabled={busy} onClick={() => setProposal(null)}>Discard proposal</button>
    </>}
  </details>;
}
