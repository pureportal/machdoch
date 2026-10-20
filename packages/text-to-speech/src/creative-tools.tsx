import { useEffect, useMemo, useRef, useState } from "react";
import {
  copyProjectVariant,
  importDialogue,
  importSpeechDocument,
  parseDialogueTable,
  updateProjectVariant,
  MAX_SPEECH_SOURCE_BYTES,
} from "@machdoch/speech";
import type { SpeechProject, SpeechRuntime, ReadingSentence } from "@machdoch/speech";
import { speechPlayback } from "@machdoch/speech";

import {Templates} from "./templates.tsx";
import {OWNER} from "./controls.tsx";

export interface SpeechCreativeToolsProps {
  runtime: SpeechRuntime;
  project: SpeechProject;
  sentences: ReadingSentence[];
  onChange: (project: SpeechProject) => void;
  onJump: (offset: number) => void;
  onPreview?: (source: string) => void | Promise<void>;
}

type ImportFormat = "text" | "markdown" | "csv" | "tsv";

export function SpeechCreativeTools({ runtime, project, sentences, onChange, onJump, onPreview }: SpeechCreativeToolsProps) {
  const [importFormat, setImportFormat] = useState<ImportFormat>("text");
  const [importSource, setImportSource] = useState("");
  const [stripMetadata, setStripMetadata] = useState(false);
  const [headerRow, setHeaderRow] = useState(true);
  const [textColumn, setTextColumn] = useState("");
  const [speakerColumn, setSpeakerColumn] = useState("");
  const [castBindings, setCastBindings] = useState<Record<string, string>>({});
  const [variantId, setVariantId] = useState("");
  const [language, setLanguage] = useState("");
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [bookmarkOffset, setBookmarkOffset] = useState("0");
  const [sentenceOffset, setSentenceOffset] = useState(0);
  const [sleepMinutes, setSleepMinutes] = useState("15");
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const sleepTarget=useRef<{owner:string;itemId:string}|null>(null);
  const [error, setError] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const fileRequest = useRef(0);
  const tableFormat = importFormat === "csv" || importFormat === "tsv";
  const table = useMemo(
    () => tableFormat ? parseDialogueTable(importSource, importFormat === "csv" ? "," : "\t") : null,
    [importFormat, importSource, tableFormat],
  );
  const dialogueRows = useMemo(() => table ? table.rows.slice(headerRow ? 1 : 0) : [], [table, headerRow]);
  const speakers = useMemo(
    () => speakerColumn === "" ? [] : [...new Set(dialogueRows.map(row => row[Number(speakerColumn)]).filter((speaker): speaker is string => speaker !== undefined))],
    [dialogueRows, speakerColumn],
  );
  const importPreview = useMemo(() => {
    if (table) {
      const currentBindings = Object.fromEntries(
        Object.entries(castBindings).filter(([, id]) => project.cast.some(member => member.id === id)),
      );
      const dialogue = importDialogue(dialogueRows, {
        textColumn: textColumn === "" ? -1 : Number(textColumn),
        speakerColumn: speakerColumn === "" ? -1 : Number(speakerColumn),
        castBindings: currentBindings,
      });
      return { source: dialogue.source, diagnostics: [...table.diagnostics, ...dialogue.diagnostics] };
    }
    return importSpeechDocument(importSource, {
      format: importFormat === "markdown" ? "markdown" : "text",
      stripStructuralMetadata: stripMetadata,
    });
  }, [table, dialogueRows, textColumn, speakerColumn, castBindings, project.cast, importSource, importFormat, stripMetadata]);
  const selectedVariant = project.variants.find(variant => variant.id === variantId);
  const sentenceIndex = sentences.findIndex(sentence => sentence.to > sentenceOffset);
  const sentence = sentenceIndex < 0 ? undefined : sentences[sentenceIndex];

  useEffect(() => {
    setSentenceOffset(0);
    setBookmarkOffset("0");
    setSleepUntil(null);
    sleepTarget.current=null;
    setVariantId("");
    setImportSource("");
    setCastBindings({});
    setTextColumn("");
    setSpeakerColumn("");
    setError("");
    fileRequest.current++;
    setReadingFile(false);
  }, [project.id]);

  useEffect(() => {
    return () => { fileRequest.current++; };
  }, []);

  useEffect(() => {
    if (sleepUntil === null) return;
    const target=sleepTarget.current;
    if(!target)return;
    const unsubscribe=speechPlayback.subscribe(state=>{
      if(state.owner!==target.owner||state.itemId!==target.itemId){sleepTarget.current=null;setSleepUntil(null);}
    });
    const timer = window.setTimeout(() => {
      const state=speechPlayback.snapshot();
      if(state.owner===target.owner&&state.itemId===target.itemId)speechPlayback.pause();
      sleepTarget.current=null;
      setSleepUntil(null);
    }, Math.max(0, sleepUntil - Date.now()));
    return () => {window.clearTimeout(timer);unsubscribe();};
  }, [sleepUntil]);

  function change(action: () => SpeechProject): void {
    try {
      onChange(action());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The project could not be updated.");
    }
  }

  async function readFile(file: File): Promise<void> {
    const request = ++fileRequest.current;
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const formats: Record<string, ImportFormat> = { txt: "text", md: "markdown", markdown: "markdown", csv: "csv", tsv: "tsv" };
    if (!extension || !Object.hasOwn(formats, extension)) {
      setError("Choose a TXT, Markdown, CSV, or TSV file.");
      return;
    }
    if(file.size>MAX_SPEECH_SOURCE_BYTES){setError("Choose a script file no larger than 4 MiB.");return;}
    setReadingFile(true);
    setError("");
    try {
      const source = await file.text();
      if (request !== fileRequest.current) return;
      setImportFormat(formats[extension]!);
      setImportSource(source);
      setTextColumn("");
      setSpeakerColumn("");
      setCastBindings({});
      setStripMetadata(false);
    } catch (failure) {
      if (request === fileRequest.current) setError(failure instanceof Error ? failure.message : "The file could not be read. Choose it again.");
    } finally {
      if (request === fileRequest.current) setReadingFile(false);
    }
  }

  async function preview(source: string): Promise<void> {
    if (!onPreview) return;
    setPreviewing(true);
    setError("");
    try {
      await onPreview(source);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The preview could not be played.");
    } finally {
      setPreviewing(false);
    }
  }

  function jump(offset: number): void {
    setSentenceOffset(offset);
    setBookmarkOffset(String(offset));
    onJump(offset);
  }

  function addBookmark(): void {
    const offset = bookmarkOffset.trim() === "" ? NaN : Number(bookmarkOffset);
    if (!bookmarkLabel.trim() || !Number.isInteger(offset) || offset < 0 || offset > project.source.length) {
      setError("Enter a bookmark name and an offset within the script.");
      return;
    }
    if (offset > 0 && /[\uD800-\uDBFF]/u.test(project.source[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(project.source[offset] ?? "")) {
      setError("Choose an offset at the start or end of the Unicode character.");
      return;
    }
    change(() => ({
      ...project,
      bookmarks: [...project.bookmarks, { id: crypto.randomUUID(), label: bookmarkLabel.trim(), offset }],
    }));
    setBookmarkLabel("");
  }

  function setTimer(): void {
    const minutes = Number(sleepMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
      setError("Enter a sleep time between 0 and 1440 minutes.");
      return;
    }
    const state=speechPlayback.snapshot();
    if(state.owner!==OWNER||!state.itemId?.startsWith("reading:")||!["playing","paused","loading","blocked"].includes(state.status)){
      setError("Start project reading before setting a sleep timer.");return;
    }
    setError("");
    sleepTarget.current={owner:state.owner,itemId:state.itemId};
    setSleepUntil(Date.now() + minutes * 60_000);
  }

  return (
    <div className="speech-creative-tools">
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Import</summary>
        <label>
          File
          <input type="file" accept=".txt,.md,.markdown,.csv,.tsv,text/plain,text/markdown,text/csv,text/tab-separated-values" disabled={readingFile} onChange={event => {
            const file = event.currentTarget.files?.[0];
            if (file) void readFile(file);
            event.currentTarget.value = "";
          }} />
        </label>
        <label>
          Format
          <select value={importFormat} onChange={event => {
            setImportFormat(event.currentTarget.value as ImportFormat);
            setTextColumn("");
            setSpeakerColumn("");
            setCastBindings({});
          }}>
            <option value="text">Plain text</option>
            <option value="markdown">Markdown</option>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
          </select>
        </label>
        <label>
          Source
          <textarea value={importSource} onChange={event => setImportSource(event.currentTarget.value)} rows={6} />
        </label>
        {importFormat === "markdown" && <label>
          <input type="checkbox" checked={stripMetadata} onChange={event => setStripMetadata(event.currentTarget.checked)} />
          Remove front matter and comments
        </label>}
        {table && <>
          <label>
            <input type="checkbox" checked={headerRow} onChange={event => setHeaderRow(event.currentTarget.checked)} />
            First row contains headers
          </label>
          {(["text", "speaker"] as const).map(kind => <label key={kind}>
            {kind === "text" ? "Text column" : "Speaker column"}
            <select value={kind === "text" ? textColumn : speakerColumn} onChange={event => {
              if (kind === "text") setTextColumn(event.currentTarget.value);
              else {
                setSpeakerColumn(event.currentTarget.value);
                setCastBindings({});
              }
            }}>
              <option value="">Choose column</option>
              {Array.from({ length: table.rows[0]?.length ?? 0 }, (_, index) => <option
                key={index}
                value={index}
                disabled={String(index) === (kind === "text" ? speakerColumn : textColumn)}
              >
                {headerRow && table.rows[0]![index]!.trim() ? table.rows[0]![index] : "Column " + (index + 1)}
              </option>)}
            </select>
          </label>)}
          {speakers.filter(speaker => speaker.trim()).map(speaker => <label key={speaker}>
            {speaker}
            <select value={Object.hasOwn(castBindings, speaker) ? castBindings[speaker] : ""} onChange={event => {
              const id = event.currentTarget.value;
              setCastBindings(previous => ({ ...previous, [speaker]: id }));
            }}>
              <option value="">Choose cast member</option>
              {project.cast.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>)}
          {table.rows.length > 0 && <div style={{ maxHeight: 240, overflow: "auto" }}>
            <table aria-label="Dialogue import">
              {headerRow && <thead><tr>{table.rows[0]!.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>}
              <tbody>{dialogueRows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ whiteSpace: "pre-wrap" }}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>}
        </>}
        {importSource !== "" && <>
          {importPreview.diagnostics.length > 0 && <ul role="alert">{importPreview.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic.message}</li>)}</ul>}
          {importPreview.source !== "" && importPreview.source !== importSource && <textarea aria-label="Import preview" readOnly rows={6} value={importPreview.source}/>}
          {onPreview && <button type="button" disabled={!importPreview.source.trim() || importPreview.diagnostics.length > 0 || previewing || readingFile} onClick={() => void preview(importPreview.source)}>Play import</button>}
          <button type="button" disabled={!importPreview.source.trim() || importPreview.diagnostics.length > 0 || readingFile} onClick={() => change(() => ({ ...project, source: importPreview.source }))}>Apply import</button>
        </>}
      </details>
      <details><summary>Templates</summary><Templates key={project.id} runtime={runtime} project={project} onChange={onChange}/></details>
      <details>
        <summary>Language variants</summary>
        <label>
          Language
          <input value={language} onChange={event => setLanguage(event.currentTarget.value)} />
        </label>
        <button type="button" disabled={!language.trim()} onClick={() => change(() => {
          const id = crypto.randomUUID();
          const next = copyProjectVariant(project, null, { id, language });
          setVariantId(id);
          return next;
        })}>Copy script</button>
        {project.variants.length > 0 && <label>
          Variant
          <select value={variantId} onChange={event => setVariantId(event.currentTarget.value)}>
            <option value="">Choose variant</option>
            {project.variants.map(variant => <option key={variant.id} value={variant.id}>{variant.language}</option>)}
          </select>
        </label>}
        {selectedVariant && <>
          <div className="speech-variant-columns" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <label>
              Original
              <textarea readOnly value={project.source} rows={8} dir="auto" />
            </label>
            <label>
              {selectedVariant.language}
              <textarea value={selectedVariant.source} onChange={event => {
                const source = event.currentTarget.value;
                change(() => updateProjectVariant(project, { ...selectedVariant, source }));
              }} rows={8} dir="auto" />
            </label>
          </div>
          {onPreview && <button type="button" disabled={!selectedVariant.source.trim() || previewing} onClick={() => void preview(selectedVariant.source)}>Play variant</button>}
          <button type="button" disabled={!language.trim()} onClick={() => change(() => {
            const id = crypto.randomUUID();
            const next = copyProjectVariant(project, selectedVariant.id, { id, language });
            setVariantId(id);
            return next;
          })}>Copy variant</button>
          <button type="button" onClick={() => change(() => {
            setVariantId("");
            return { ...project, variants: project.variants.filter(variant => variant.id !== selectedVariant.id) };
          })}>Remove variant</button>
        </>}
      </details>
      <details>
        <summary>Bookmarks</summary>
        <label>Name<input value={bookmarkLabel} onChange={event => setBookmarkLabel(event.currentTarget.value)} /></label>
        <label>Source offset<input type="number" min={0} max={project.source.length} step={1} value={bookmarkOffset} onChange={event => setBookmarkOffset(event.currentTarget.value)} /></label>
        <button type="button" disabled={!bookmarkLabel.trim()} onClick={addBookmark}>Add bookmark</button>
        <ul>{project.bookmarks.map(bookmark => <li key={bookmark.id}>
          <button type="button" disabled={bookmark.offset < 0 || bookmark.offset > project.source.length} onClick={() => jump(bookmark.offset)}>{bookmark.label}</button>
          <button type="button" aria-label={"Remove bookmark " + bookmark.label} onClick={() => change(() => ({
            ...project,
            bookmarks: project.bookmarks.filter(item => item.id !== bookmark.id),
          }))}>Remove</button>
        </li>)}</ul>
      </details>
      <details>
        <summary>Reading</summary>
        <button type="button" disabled={sentenceIndex <= 0} onClick={() => { const previous = sentences[sentenceIndex - 1]; if (previous) jump(previous.from); }}>Previous sentence</button>
        <button type="button" disabled={sentenceIndex < 0 || sentenceIndex >= sentences.length - 1} onClick={() => { const next = sentences[sentenceIndex + 1]; if (next) jump(next.from); }}>Next sentence</button>
        {onPreview && sentence && <button type="button" disabled={previewing} onClick={() => void preview(sentence.source)}>Read sentence</button>}
        <button type="button" onClick={() => {if(speechPlayback.snapshot().owner===OWNER)speechPlayback.pause();}}>Pause</button>
        <ol aria-label="Transcript" style={{ maxHeight: 320, overflow: "auto" }}>
          {sentences.slice(Math.max(0, sentenceIndex - 40), Math.max(0, sentenceIndex - 40) + 80).map((item, index) => <li key={item.from}>
            <button type="button" aria-current={index + Math.max(0, sentenceIndex - 40) === sentenceIndex ? "step" : undefined} onClick={() => jump(item.from)}>{item.text}</button>
          </li>)}
        </ol>
        <label>Sleep minutes<input type="number" min={0.1} max={1440} step="any" value={sleepMinutes} onChange={event => setSleepMinutes(event.currentTarget.value)} /></label>
        <button type="button" onClick={setTimer}>Set sleep timer</button>
        {sleepUntil !== null && <>
          <time dateTime={new Date(sleepUntil).toISOString()}>{new Date(sleepUntil).toLocaleTimeString()}</time>
          <button type="button" onClick={() => setSleepUntil(null)}>Cancel sleep timer</button>
        </>}
      </details>
    </div>
  );
}
