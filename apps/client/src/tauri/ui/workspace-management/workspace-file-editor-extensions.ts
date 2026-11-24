import { unifiedMergeView } from "@codemirror/merge";
import { gotoLine } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, keymap } from "@codemirror/view";
import type { BlameLineLabel } from "./workspace-file-blame";

class BlameMarker extends GutterMarker {
  constructor(private readonly label: BlameLineLabel) {
    super();
  }

  override eq(other: BlameMarker): boolean {
    return (
      other.label.text === this.label.text &&
      other.label.title === this.label.title
    );
  }

  override toDOM(): Node {
    const element = document.createElement("span");
    element.textContent = this.label.text;
    element.title = this.label.title;
    element.className = this.label.uncommitted
      ? "cm-blame-label cm-blame-uncommitted"
      : "cm-blame-label";
    return element;
  }
}

const blameTheme = EditorView.theme({
  ".cm-blame-gutter": { width: "15rem", color: "#64748b", fontSize: "11px" },
  ".cm-blame-label": {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingRight: "8px",
  },
  ".cm-blame-uncommitted": { color: "#fbbf24" },
});

export const blameGutter = (labels: Map<number, BlameLineLabel>): Extension => [
  gutter({
    class: "cm-blame-gutter",
    lineMarker: (view, line) => {
      const label = labels.get(view.state.doc.lineAt(line.from).number);
      return label ? new BlameMarker(label) : null;
    },
    lineMarkerChange: () => false,
  }),
  blameTheme,
];

export const comparisonView = (
  original: string,
  mergeControls: boolean,
): Extension =>
  unifiedMergeView({
    original,
    mergeControls,
    highlightChanges: true,
    gutter: true,
  });

export const goToLineKeymap: Extension = keymap.of([
  { key: "Mod-g", preventDefault: true, run: gotoLine },
]);

export const revealLine = (view: EditorView, line: number): void => {
  const target = view.state.doc.line(
    Math.max(1, Math.min(line, view.state.doc.lines)),
  );
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
};
