import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Plus, Save, Upload } from "lucide-react";
import {
  validateDictionaries,
  type PhonemeAlphabet,
  type SpeechDictionary,
  type SpeechRuntime,
  type SpeechProfile,
  type SpeechSettings,
} from "@machdoch/speech";
import { Field, type Run } from "./controls.tsx";
import { downloadDictionary, readDictionaryFile } from "./dictionary-files.ts";
import {PronunciationRehearsal} from "./pronunciation-rehearsal.tsx";
import {usePronunciationPreview} from "./use-pronunciation-preview.ts";

const freshDictionary = (): SpeechDictionary => ({ id: crypto.randomUUID(), name: "", revision: "", rules: [] });

export function DictionariesPanel({ runtime, dictionaries, profiles, settings, assetUrl, run, busy, saved }: {
  runtime: SpeechRuntime; dictionaries: SpeechDictionary[]; profiles:SpeechProfile[];settings:SpeechSettings|null;assetUrl(path:string):string;run: Run; busy: boolean; saved(dictionary: SpeechDictionary): void;
}) {
  const [draft, setDraft] = useState<SpeechDictionary>(freshDictionary);
  const [rehearsalIds, setRehearsalIds] = useState<string[]>([]);
  const [source,setSource]=useState("");
  const [ruleSearch,setRuleSearch]=useState("");
  const [rulePage,setRulePage]=useState(0);
  const importInput = useRef<HTMLInputElement>(null);
  const formId = useId();
  const ruleEditor=useRef<HTMLFormElement>(null);
  const movedRule=useRef<string|null>(null);
  const ruleIssues = useMemo(() => {
    const byRule = new Map<string, string[]>();
    for (const { ruleId, message } of validateDictionaries([draft])) {
      if (ruleId === undefined) continue;
      const messages = byRule.get(ruleId);
      if (messages) messages.push(message);
      else byRule.set(ruleId, [message]);
    }
    return byRule;
  }, [draft]);
  const tooManyRules = draft.rules.length > 5000;
  const savedDictionary = dictionaries.find(item => item.id === draft.id);
  const visibleRules=draft.rules.map((rule,index)=>({rule,index})).filter(({rule})=>!ruleSearch||[rule.text,rule.phonemes].some(value=>value.toLocaleLowerCase().includes(ruleSearch.toLocaleLowerCase())));
  const currentPage=Math.min(rulePage,Math.max(0,Math.ceil(visibleRules.length/50)-1));
  useEffect(()=>{const id=movedRule.current;if(id){movedRule.current=null;ruleEditor.current?.querySelector<HTMLElement>(`[data-rule-id="${CSS.escape(id)}"]`)?.focus();}},[draft.rules,currentPage]);
  const changeRule = (id: string, change: Partial<SpeechDictionary["rules"][number]>) => setDraft(value => ({
    ...value, rules: value.rules.map(rule => rule.id === id ? { ...rule, ...change } : rule),
  }));
  const acceptSaved = (dictionary: SpeechDictionary): void => {
    saved(dictionary);
    setDraft(dictionary);
    setRehearsalIds(ids => ids.includes(dictionary.id) ? ids : [dictionary.id]);
  };

  return <div className="tts-stack">
    <div className="tts-row"><h2>Dictionaries</h2>
      <select aria-label="Edit dictionary" disabled={busy} value={savedDictionary ? draft.id : ""} onChange={event => {
        const item = dictionaries.find(dictionary => dictionary.id === event.target.value);
        if (item) {
          setDraft({ ...item, rules: item.rules.map(rule => ({ ...rule })) });setRuleSearch("");setRulePage(0);
          setRehearsalIds([item.id]);
        }
      }}><option value="">New dictionary</option>{dictionaries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button disabled={busy} onClick={() => { setDraft(freshDictionary()); setRehearsalIds([]); }}><Plus size={16} />New dictionary</button>
      <button disabled={busy} onClick={() => importInput.current?.click()}><Upload size={16} />Import dictionary</button>
      <input ref={importInput} type="file" hidden accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void run(async () => {
          const dictionary = await readDictionaryFile(file);
          acceptSaved(await runtime.execute("saveDictionary", { dictionary }));
        });
      }} />
      <button disabled={busy || !savedDictionary} onClick={() => {
        if (savedDictionary) void run(async () => downloadDictionary(savedDictionary));
      }}><Download size={16} />Export saved dictionary</button>
    </div>
    <form ref={ruleEditor} className="tts-stack" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        if (!draft.name.trim()) throw new Error("Enter a dictionary name.");
        if (tooManyRules || ruleIssues.size) throw new Error("Fix the dictionary errors before saving.");
        acceptSaved(await runtime.execute("saveDictionary", { dictionary: { ...draft, name: draft.name.trim() } }));
      });
    }}>
      <Field label="Name"><input value={draft.name} required disabled={busy} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} /></Field>
      <Field label="Search rules"><input type="search" value={ruleSearch} onChange={event=>{setRuleSearch(event.target.value);setRulePage(0);}}/></Field>
      {visibleRules.slice(currentPage*50,currentPage*50+50).map(({rule,index}) => {
        const issues = ruleIssues.get(rule.id) ?? [];
        const diagnosticsId = formId + "-rule-" + index;
        return <fieldset className="tts-grid" key={rule.id} disabled={busy} tabIndex={-1} data-rule-id={rule.id}>
          <legend>Rule {index + 1}</legend>
          <Field label="Text"><input dir="auto" value={rule.text} required aria-invalid={issues.length > 0} aria-describedby={issues.length ? diagnosticsId : undefined} onChange={event => changeRule(rule.id, { text: event.target.value })} /></Field>
          <Field label="Phonemes"><input value={rule.phonemes} required aria-invalid={issues.length > 0} aria-describedby={issues.length ? diagnosticsId : undefined} onChange={event => changeRule(rule.id, { phonemes: event.target.value })} /></Field>
          <Field label="Alphabet"><select value={rule.alphabet} onChange={event => changeRule(rule.id, { alphabet: event.target.value as PhonemeAlphabet })}>
            <option value="arpabet">ARPAbet</option><option value="pinyin">Pinyin</option><option value="romaji">Romaji</option>
          </select></Field>
          <label className="tts-check"><input type="checkbox" checked={rule.caseSensitive} onChange={event => changeRule(rule.id, { caseSensitive: event.target.checked })} />Case sensitive</label>
          <button type="button" onClick={() => setDraft(value => ({ ...value, rules: value.rules.filter(item => item.id !== rule.id) }))}>Remove rule</button>
          <div className="tts-row">{([-1,1] as const).map(delta=><button key={delta} type="button" disabled={busy||!!ruleSearch||index+delta<0||index+delta>=draft.rules.length} onClick={()=>{movedRule.current=rule.id;setRulePage(Math.floor((index+delta)/50));setDraft(value=>{const rules=[...value.rules];[rules[index],rules[index+delta]]=[rules[index+delta]!,rules[index]!];return {...value,rules};});}}>{delta<0?"Move rule up":"Move rule down"}</button>)}</div>
          {issues.length > 0 && <ul id={diagnosticsId} role="alert" style={{ gridColumn: "1 / -1" }}>
            {issues.map((message, issueIndex) => <li key={issueIndex}>{message}</li>)}
          </ul>}
        </fieldset>;
      })}
      {ruleSearch&&visibleRules.length>0&&<p>Clear the search to reorder rules.</p>}
      {visibleRules.length>50&&<div className="tts-row"><button type="button" disabled={currentPage===0} onClick={()=>setRulePage(currentPage-1)}>Previous rules</button><output>Rules page {currentPage+1} of {Math.ceil(visibleRules.length/50)}</output><button type="button" disabled={(currentPage+1)*50>=visibleRules.length} onClick={()=>setRulePage(currentPage+1)}>Next rules</button></div>}
      {draft.rules.some(rule=>ruleIssues.has(rule.id)&&!visibleRules.slice(currentPage*50,currentPage*50+50).some(item=>item.rule.id===rule.id))&&<button type="button" onClick={()=>{setRuleSearch("");setRulePage(Math.floor(draft.rules.findIndex(rule=>ruleIssues.has(rule.id))/50));}}>Show invalid rule</button>}
      {draft.rules.length >= 5000 && <p role={tooManyRules ? "alert" : "status"}>
        {tooManyRules ? "Remove rules until no more than 5,000 remain." : "Remove a rule to add another; dictionaries allow up to 5,000 rules."}
      </p>}
      <div className="tts-row">
        <button type="button" disabled={busy || draft.rules.length >= 5000} onClick={() => {setRuleSearch("");setRulePage(Math.floor(draft.rules.length/50));setDraft(value => ({
          ...value, rules: [...value.rules, { id: crypto.randomUUID(), text: "", phonemes: "", alphabet: "arpabet", caseSensitive: false }],
        }));}}><Plus size={16} />Add rule</button>
        <button disabled={busy || tooManyRules || ruleIssues.size > 0}><Save size={16} />Save dictionary</button>
      </div>
    </form>
    <DictionaryRehearsal dictionaries={dictionaries} selectedIds={rehearsalIds} select={setRehearsalIds} source={source} setSource={setSource}/>
    {dictionaries.filter(dictionary=>dictionary.id===rehearsalIds[0]).map(dictionary=><PronunciationRehearsal key={dictionary.id} runtime={runtime} dictionary={dictionary} companions={rehearsalIds.slice(1).flatMap(id=>dictionaries.filter(item=>item.id===id))} source={source} useSource={setSource} profiles={profiles} settings={settings} assetUrl={assetUrl} run={run} busy={busy}/>)}
  </div>;
}

function DictionaryRehearsal({ dictionaries, selectedIds, select, source, setSource }: {
  dictionaries: SpeechDictionary[]; selectedIds: string[]; select(ids: string[]): void;source:string;setSource(source:string):void;
}) {
  const selected = useMemo(() => selectedIds.flatMap(id => dictionaries.filter(dictionary => dictionary.id === id)), [dictionaries, selectedIds]);
  const issues = useMemo(() => validateDictionaries(selected), [selected]);
  const [textPage,setTextPage]=useState(0);
  const page=Math.min(textPage,Math.max(0,Math.ceil(source.length/2048)-1));
  const preview=usePronunciationPreview(source,selected,page);
  const matches=preview.result?.matches??[];
  const names = new Map(selected.map(dictionary => [dictionary.id, dictionary.name]));

  return <section className="tts-stack">
    <h3>Text rehearsal</h3>
    {dictionaries.length > 0 && <fieldset className="tts-row">
      <legend>Saved dictionaries (up to 3)</legend>
      {dictionaries.map(dictionary => <label className="tts-check" key={dictionary.id}>
        <input type="checkbox" checked={selectedIds.includes(dictionary.id)} disabled={!selectedIds.includes(dictionary.id) && selectedIds.length >= 3} onChange={event => {
          select(event.target.checked ? [...selectedIds, dictionary.id] : selectedIds.filter(id => id !== dictionary.id));
        }} />{dictionary.name}
      </label>)}
    </fieldset>}
    <Field label="Text"><textarea rows={4} dir="auto" value={source} onChange={event => setSource(event.target.value)} /></Field>
    {source.length>2048&&<div className="tts-row"><button disabled={page===0} onClick={()=>setTextPage(page-1)}>Previous text</button><output>Text page {page+1} of {Math.ceil(source.length/2048)}</output><button disabled={(page+1)*2048>=source.length} onClick={()=>setTextPage(page+1)}>Next text</button></div>}
    {issues.length > 0 && <ul role="alert">{issues.map((issue, index) => {
      const dictionary = selected.find(item => item.id === issue.dictionaryId);
      const ruleIndex = dictionary?.rules.findIndex(rule => rule.id === issue.ruleId) ?? -1;
      return <li key={index}>{dictionary ? dictionary.name + (ruleIndex >= 0 ? ", rule " + (ruleIndex + 1) : "") + ": " : ""}{issue.message}</li>;
    })}</ul>}
    {source && selected.length === 0 && <p role="status">
      {dictionaries.length ? "Select a dictionary to rehearse its pronunciation." : "Save a dictionary to rehearse its pronunciation."}
    </p>}
    {source && selected.length > 0 && issues.length === 0 && (preview.error?<><p role="alert">{preview.error}</p><button onClick={preview.reload}>Reload pronunciation preview</button></>:!preview.result?<output>Finding pronunciations…</output>:<>
      <pre dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {matches.map((match, index) => <span key={match.from}>
          {source.slice(index ? matches[index - 1]!.to : preview.result!.from, match.from)}<mark>{match.original}</mark>
        </span>)}
        {source.slice(matches.length ? matches[matches.length - 1]!.to : preview.result.from,preview.result.to)}
      </pre>
      {matches.length > 0 ? <table>
        <thead><tr><th scope="col">Text</th><th scope="col">Phonemes</th><th scope="col">Dictionary</th></tr></thead>
        <tbody>{matches.map(match => <tr key={match.from}>
          <td dir="auto">{match.original}</td><td>{match.phonemes}</td><td>{names.get(match.dictionaryId)}</td>
        </tr>)}</tbody>
      </table> : <p role="status">No matches.</p>}
    </>)}
  </section>;
}
