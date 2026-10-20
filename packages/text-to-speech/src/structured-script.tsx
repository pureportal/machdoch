import { useEffect, useRef, useState } from "react";
import { serializeSpeechScript, type SpeechScript } from "@machdoch/speech";
import { Field } from "./controls.tsx";

const PAGE_SIZE = 80;

export function StructuredScript({script, source, onChange}: {script: SpeechScript; source: string; onChange(source: string): void}) {
  const [nodes, setNodes] = useState(script.nodes);
  const [focused, setFocused] = useState(false);
  const [page, setPage] = useState(0);
  const current = useRef(nodes);
  useEffect(() => {
    if (!focused && script.source === source) {
      current.current = script.nodes;
      setNodes(script.nodes);
    }
  }, [script, source, focused]);
  const lastPage = Math.max(0, Math.ceil(nodes.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  return <div className="tts-structured" onFocus={() => setFocused(true)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }}>
    {lastPage > 0 && <nav className="tts-row" aria-label="Script blocks">
      <button disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Previous blocks</button>
      <span>{activePage + 1} / {lastPage + 1}</span>
      <button disabled={activePage === lastPage} onClick={() => setPage(activePage + 1)}>Next blocks</button>
    </nav>}
    {nodes.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map((node, position) => {
      const index = activePage * PAGE_SIZE + position;
      return <Field key={index} label={node.kind}><textarea dir="auto" value={node.raw} onChange={event => {
        const next = current.current.map((item, offset) => offset === index ? {...item, raw: event.target.value} : item);
        current.current = next;
        setNodes(next);
        onChange(serializeSpeechScript({...script, nodes: next}));
      }} /></Field>;
    })}
    <button onClick={() => onChange(source + "\n")}>Add text</button>
  </div>;
}
