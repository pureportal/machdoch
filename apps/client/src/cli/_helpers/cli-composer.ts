import { layoutPrompt } from "./cli-prompt-layout.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface PromptDraft {
  text: string;
  cursor: number;
  pasted: boolean;
}

export class PromptComposer {
  draft: PromptDraft = { text: "", cursor: 0, pasted: false };
  history: PromptDraft[];
  search: string | undefined;
  private historyIndex = -1;
  private savedDraft: PromptDraft = this.draft;
  private searchIndex = -1;
  private searchDraft: PromptDraft = this.draft;
  private undo: PromptDraft[] = [];
  private killed = "";

  constructor(history: readonly string[] = []) {
    this.history = history.map((text) => ({
      text,
      cursor: text.length,
      pasted: text.includes("\n") || text.startsWith("/"),
    }));
  }

  replace(text: string, pasted = false): void {
    this.undo.push({ ...this.draft });
    if (this.undo.length > 100) this.undo.shift();
    this.draft = { text, cursor: text.length, pasted };
  }

  insert(text: string, pasted = false): void {
    const { text: previous, cursor } = this.draft;
    const from = previous.slice(0, cursor);
    this.replace(
      from + text + previous.slice(cursor),
      this.draft.pasted || pasted,
    );
    this.draft.cursor = cursor + text.length;
  }

  remove(start: number, end: number, kill = false): void {
    const { text, pasted } = this.draft;
    if (kill) this.killed = text.slice(start, end);
    this.replace(text.slice(0, start) + text.slice(end), pasted);
    this.draft.cursor = start;
  }

  moveCharacter(direction: -1 | 1): void {
    const { text, cursor } = this.draft;
    const segments = Array.from(graphemes.segment(text));
    this.draft.cursor =
      direction === -1
        ? (segments.filter((segment) => segment.index < cursor).at(-1)?.index ??
          0)
        : (segments.find((segment) => segment.index >= cursor)?.index ??
          text.length);
    if (direction === 1 && cursor < text.length) {
      const segment = segments.find(
        (segment) => segment.index === this.draft.cursor,
      );
      this.draft.cursor += segment?.segment.length ?? 0;
    }
  }

  moveWord(direction: -1 | 1): void {
    const { text, cursor } = this.draft;
    this.draft.cursor =
      direction === -1
        ? text.slice(0, cursor).replace(/\S+\s*$/u, "").length
        : cursor +
          (/^\s*\S+\s*/u.exec(text.slice(cursor))?.[0].length ??
            text.length - cursor);
  }

  lineBoundary(end: boolean): number {
    const { text, cursor } = this.draft;
    return end
      ? text.indexOf("\n", cursor) < 0
        ? text.length
        : text.indexOf("\n", cursor)
      : text.lastIndexOf("\n", cursor - 1) + 1;
  }

  moveVertical(
    direction: -1 | 1,
    prompt = "",
    width = Number.MAX_SAFE_INTEGER,
  ): void {
    const { text, cursor } = this.draft;
    const { positions } = layoutPrompt(text, prompt, width);
    const position = positions.find((position) => position.offset === cursor)!;
    const targets = positions.filter(
      (target) => target.row === position.row + direction,
    );
    if (!targets.length) {
      this.recall(direction);
      return;
    }
    this.draft.cursor = targets.reduce((closest, target) =>
      Math.abs(target.column - position.column) <
      Math.abs(closest.column - position.column)
        ? target
        : closest,
    ).offset;
  }

  recall(direction: -1 | 1): void {
    if (!this.history.length) return;
    if (this.historyIndex === -1 && direction === 1) return;
    if (this.historyIndex === -1 && direction === -1)
      this.savedDraft = { ...this.draft };
    this.historyIndex = Math.max(
      -1,
      Math.min(this.history.length - 1, this.historyIndex - direction),
    );
    this.draft = {
      ...(this.historyIndex < 0
        ? this.savedDraft
        : this.history[this.historyIndex]!),
    };
  }

  beginSearch(): void {
    if (this.search === undefined) {
      this.searchDraft = { ...this.draft };
      this.search = "";
      this.searchIndex = -1;
    }
    this.findSearch(true);
  }

  updateSearch(query: string): void {
    this.search = query;
    this.searchIndex = -1;
    this.findSearch(true);
  }

  private findSearch(next: boolean): void {
    const index = this.history.findIndex(
      (entry, index) =>
        (!next || index > this.searchIndex) &&
        entry.text.toLowerCase().includes((this.search ?? "").toLowerCase()),
    );
    if (index < 0) {
      this.draft = { ...this.searchDraft };
      return;
    }
    this.searchIndex = index;
    this.draft = {
      ...this.history[index]!,
      cursor: this.history[index]!.text.length,
    };
  }

  endSearch(cancel = false): void {
    if (cancel) this.draft = this.searchDraft;
    this.search = undefined;
    this.historyIndex = -1;
  }

  undoEdit(): void {
    const draft = this.undo.pop();
    if (draft) this.draft = draft;
  }

  yank(): void {
    this.insert(this.killed);
  }

  submit(): PromptDraft {
    const draft = { ...this.draft };
    if (draft.text.trim()) {
      this.history = [
        draft,
        ...this.history.filter((entry) => entry.text !== draft.text),
      ].slice(0, 500);
    }
    this.clear();
    return draft;
  }

  clear(): void {
    this.draft = { text: "", cursor: 0, pasted: false };
    this.historyIndex = -1;
    this.search = undefined;
    this.undo = [];
  }
}
