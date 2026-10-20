import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorSelection } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { bracketMatching, foldService, foldGutter, foldKeymap } from "@codemirror/language";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { DELIVERY_TAGS, speechCompletions, type DeliveryTag, type SourceRange, type SpeechDiagnostic, type SpeechScript } from "@machdoch/speech";

export interface SpeechEditorHandle {
  focusRange(range: SourceRange): void;
  insert(text: string): void;
  wrap(tag: DeliveryTag): void;
  undo(): void;
  redo(): void;
}

interface SpeechEditorProps {
  source: string;
  script?: SpeechScript;
  speakers: ReadonlyArray<{ id: string; name: string }>;
  diagnostics: SpeechDiagnostic[];
  onChange(source: string): void;
  onSelection(range: SourceRange): void;
}

function decorations(view: EditorView, script?: SpeechScript): DecorationSet {
  return Decoration.set((script?.nodes ?? [])
    .filter(node => node.kind !== "text" && node.to > node.from && node.to <= view.state.doc.length && view.visibleRanges.some(range => node.to > range.from && node.from < range.to))
    .map(node => Decoration.mark({ class: "tts-token-" + node.kind }).range(node.from, node.to)));
}

function speechHighlighting(script?: SpeechScript) { return ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorations(view, script); }
  update(update: ViewUpdate): void {
    if (update.docChanged) this.decorations = Decoration.none;
    else if (update.viewportChanged) this.decorations = decorations(update.view, script);
  }
}, { decorations: plugin => plugin.decorations }); }

export const SpeechEditor = forwardRef<SpeechEditorHandle, SpeechEditorProps>(function SpeechEditor(
  { source, script, speakers, diagnostics, onChange, onSelection }, ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  const outline = useMemo(() => script?.nodes.filter(node => node.kind === "chapter" || node.kind === "scene") ?? [], [script]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const items = current === script?.source ? diagnostics : [];
    view.dispatch(setDiagnostics(view.state, items.map(item => ({
      from: Math.min(item.from, view.state.doc.length),
      to: Math.min(item.to, view.state.doc.length),
      severity: item.severity,
      message: item.message,
    }))));
  }, [source, script, diagnostics]);
  useImperativeHandle(ref, () => ({
    focusRange(range) {
      const view = viewRef.current;
      if (!view) return;
      const from = Math.max(0, Math.min(range.from, view.state.doc.length));
      const to = Math.max(from, Math.min(range.to, view.state.doc.length));
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from) });
      view.focus();
    },
    insert(text) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    wrap(tag) {
      const view = viewRef.current;
      if (!view) return;
      const opening = "<" + tag + ">";
      const closing = "</" + tag + ">";
      view.dispatch(view.state.changeByRange(range => ({
        changes: [
          { from: range.from, insert: opening },
          { from: range.to, insert: closing },
        ],
        range: EditorSelection.range(range.from + opening.length, range.to + opening.length),
      })));
      view.focus();
    },
    undo() { if (viewRef.current) undo(viewRef.current); },
    redo() { if (viewRef.current) redo(viewRef.current); },
  }), []);

  const extensions = useMemo(() => [
    speechHighlighting(script),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
    bracketMatching(),
    ...(outline.length > 1 ? [foldGutter()] : []),
    foldService.of((state, lineStart, lineEnd) => {
      const heading = outline.find(node => node.from >= lineStart && node.from <= lineEnd);
      if (!heading) return null;
      const next = outline.find(node => node.from > heading.from && (heading.kind === "scene" || node.kind === "chapter"));
      const to = next ? Math.max(lineEnd, next.from - 1) : state.doc.length;
      return to > lineEnd ? { from: lineEnd, to } : null;
    }),
    EditorView.inputHandler.of((view, from, to, text) => {
      if (text !== ">" || view.composing) return false;
      const before = view.state.sliceDoc(view.state.doc.lineAt(from).from, from);
      const match = /<([a-z]+)$/u.exec(before);
      if (!match || !(DELIVERY_TAGS as readonly string[]).includes(match[1]!)) return false;
      const closing = `</${match[1]}>`;
      if (view.state.sliceDoc(to, to + closing.length) === closing) return false;
      view.dispatch({ changes: { from, to, insert: ">" + closing }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      return true;
    }),
    ...(diagnostics.length ? [lintGutter()] : []),
    autocompletion({
      override: [(context: CompletionContext) => {
        const before = context.state.sliceDoc(0, context.pos);
        const match = /<\|speaker:([^|>]*)$|<(\/?)([\w-]*)$|<\|$/u.exec(before);
        if (!match) return null;
        const prefix = match[1] !== undefined ? "<|speaker:" : match[2] !== undefined ? "<" + match[2] : "<|";
        const from = context.pos - (match[1]?.length ?? match[3]?.length ?? 0);
        const canonical = before.slice(0, match.index) + prefix;
        const options = speechCompletions(canonical, canonical.length, speakers);
        return {
          from,
          options: options.map(option => ({
            label: option.label,
            apply: option.insertText,
            type: option.kind === "speaker" ? "variable" : "keyword",
          })),
          validFor: /^[\w-]*$/u,
        };
      }],
    }),
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),
    EditorView.contentAttributes.of({ "aria-label": "Speech script", dir: "auto", spellcheck: "false" }),
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": { overflow: "auto", fontFamily: "inherit" },
      ".cm-content": { minHeight: "18rem", unicodeBidi: "plaintext" },
    }),
  ], [script, speakers, diagnostics, outline]);

  return <>
  {(outline.length > 1 || speakers.length > 1) && <div className="tts-editor-navigation">
    {outline.length > 0 && <select aria-label="Chapter and scene outline" value="" onChange={event => {
      const node = outline.find(item => item.id === event.target.value);
      const view = viewRef.current;
      if (node && view) { view.dispatch({ selection: { anchor: node.from }, effects: EditorView.scrollIntoView(node.from) }); view.focus(); }
    }}><option value="">Outline</option>{outline.map(node => <option key={node.id} value={node.id}>{node.value}</option>)}</select>}
    {speakers.length > 1 && <select aria-label="Jump to speaker" value="" onChange={event => {
      const view = viewRef.current;
      if (!view) return;
      const nodes = script?.nodes.filter(node => node.kind === "speaker" && node.value === event.target.value) ?? [];
      const node = nodes.find(item => item.from > view.state.selection.main.to) ?? nodes[0];
      if (node) { view.dispatch({ selection: { anchor: node.from, head: node.to }, effects: EditorView.scrollIntoView(node.from) }); view.focus(); }
    }}><option value="">Jump to speaker</option>{speakers.map(speaker => <option key={speaker.id} value={speaker.id}>{speaker.name}</option>)}</select>}
  </div>}
  <CodeMirror
    className="tts-code"
    value={source}
    extensions={extensions}
    basicSetup={{ history: false, autocompletion: false, bracketMatching: false, lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
    onCreateEditor={view => { viewRef.current = view; }}
    onChange={onChange}
    onUpdate={update => {
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        onSelection({ from: range.from, to: range.to });
      }
    }}
  />
  </>;
});
