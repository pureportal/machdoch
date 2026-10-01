import process from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ReadStream, WriteStream } from "node:tty";
import {
  completeChatCommand,
  InteractiveInputCancelledError,
} from "./cli-interactive-commands.js";
import { PromptComposer } from "./cli-composer.js";
import { clipTerminalText, safeTerminalText } from "./cli-terminal-text.js";
import { createCliStyle } from "./cli-terminal.js";
import { layoutPrompt } from "./cli-prompt-layout.js";
import { editPrompt } from "./cli-editor.js";

export interface ChatLine {
  text: string;
  pasted?: boolean;
}

export interface ChatInput {
  readLine(prompt: string): Promise<ChatLine | undefined>;
  setBusy(busy: boolean): void;
  setDraft(text: string): void;
  suspend<T>(action: () => Promise<T>): Promise<T>;
  close(): void;
}

export const createChatInput = (
  options: {
    input?: ReadStream;
    output?: WriteStream;
    history?: readonly string[];
    editor?: (draft: string) => Promise<string>;
  } = {},
): ChatInput => {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const initiallyRaw = input.isRaw === true;
  const initiallyFlowing = input.readableFlowing === true;
  const composer = new PromptComposer(options.history);
  const style = createCliStyle({ isTTY: output.isTTY });
  const forwarded = new PassThrough();
  const decoder = new StringDecoder("utf8");
  const lines: ChatLine[] = [];
  let pending:
    | {
        resolve: (line: ChatLine | undefined) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let closed = false;
  let busy = false;
  let suspended = false;
  let prompt = "> ";
  let frameCursorRow = 0;
  let frameVisible = false;
  let pasteBuffer = "";
  let pastedText: string | undefined;

  const clearFrame = (): void => {
    if (!frameVisible) return;
    output.write(
      `\r${frameCursorRow ? `\u001b[${frameCursorRow}A` : ""}\u001b[J`,
    );
    frameVisible = false;
    frameCursorRow = 0;
  };

  const render = (): void => {
    if (!pending || busy || suspended || closed) return;
    clearFrame();
    const width = Math.max(4, (output.columns || 80) - 1);
    const { rows, positions } = layoutPrompt(
      composer.draft.text,
      prompt,
      width,
    );
    const { row: cursorRow, column: cursorColumn } = positions.find(
      (position) => position.offset === composer.draft.cursor,
    )!;
    const height = Math.max(1, (output.rows || 24) - 3);
    const start = Math.max(
      0,
      Math.min(cursorRow - Math.floor(height / 2), rows.length - height),
    );
    const visibleRows = rows.slice(start, start + height);
    if (composer.search !== undefined)
      visibleRows.push(style.muted(`Search: ${composer.search}`));
    output.write(visibleRows.join("\n"));
    const targetRow = cursorRow - start;
    const up = visibleRows.length - 1 - targetRow;
    output.write(
      `\r${up > 0 ? `\u001b[${up}A` : ""}${cursorColumn ? `\u001b[${cursorColumn}C` : ""}`,
    );
    frameCursorRow = targetRow;
    frameVisible = true;
  };

  const interrupt = (): void => {
    lines.length = 0;
    if (busy) {
      process.emit("SIGINT");
      return;
    }
    clearFrame();
    composer.clear();
    const request = pending;
    pending = undefined;
    request?.reject(new InteractiveInputCancelledError());
  };

  const receiveKey = (text: string | undefined, key: Key): void => {
    if (closed || suspended) return;
    if (key.ctrl && key.name === "c") {
      interrupt();
      return;
    }
    if (busy) {
      if (key.name === "escape") interrupt();
      return;
    }
    if (composer.search !== undefined) {
      if (key.ctrl && key.name === "r") composer.beginSearch();
      else if (key.name === "escape") composer.endSearch(true);
      else if (key.name === "return" || key.name === "enter")
        composer.endSearch();
      else if (key.name === "backspace")
        composer.updateSearch(
          Array.from(composer.search).slice(0, -1).join(""),
        );
      else if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text))
        composer.updateSearch(composer.search + text);
      render();
      return;
    }
    if (key.ctrl && key.name === "d" && !composer.draft.text) {
      close();
      return;
    }
    if (key.ctrl && key.name === "g") {
      void suspend(() => (options.editor ?? editPrompt)(composer.draft.text))
        .then((text) => {
          if (!closed) {
            composer.replace(safeTerminalText(text), true);
            render();
          }
        })
        .catch((error: unknown) => {
          const request = pending;
          pending = undefined;
          request?.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      return;
    }
    if (key.ctrl && key.name === "r") composer.beginSearch();
    else if (
      key.name === "return" ||
      key.name === "enter" ||
      key.sequence === "\u001b[13;2u" ||
      key.sequence === "\u001b[27;2;13~"
    ) {
      if (
        key.sequence === "\n" ||
        key.meta ||
        key.shift ||
        key.sequence?.includes(";2")
      )
        composer.insert("\n", true);
      else if (
        composer.draft.text.endsWith("\\") &&
        composer.draft.cursor === composer.draft.text.length
      ) {
        composer.remove(composer.draft.cursor - 1, composer.draft.cursor);
        composer.insert("\n", true);
      } else {
        clearFrame();
        const draft = composer.submit();
        const line = {
          text: draft.text,
          ...(draft.pasted ? { pasted: true } : {}),
        };
        output.write(`${prompt}${safeTerminalText(line.text)}\n`);
        const request = pending;
        pending = undefined;
        if (request) request.resolve(line);
        else lines.push(line);
      }
    } else if (key.ctrl && key.name === "j") composer.insert("\n", true);
    else if (key.name === "up" || (key.ctrl && key.name === "p"))
      composer.moveVertical(
        -1,
        prompt,
        Math.max(4, (output.columns || 80) - 1),
      );
    else if (key.name === "down" || (key.ctrl && key.name === "n"))
      composer.moveVertical(1, prompt, Math.max(4, (output.columns || 80) - 1));
    else if (
      (key.name === "left" && (key.ctrl || key.meta)) ||
      (key.meta && key.name === "b")
    )
      composer.moveWord(-1);
    else if (
      (key.name === "right" && (key.ctrl || key.meta)) ||
      (key.meta && key.name === "f")
    )
      composer.moveWord(1);
    else if (key.name === "left" || (key.ctrl && key.name === "b"))
      composer.moveCharacter(-1);
    else if (key.name === "right" || (key.ctrl && key.name === "f"))
      composer.moveCharacter(1);
    else if (key.ctrl && key.name === "home") composer.draft.cursor = 0;
    else if (key.ctrl && key.name === "end")
      composer.draft.cursor = composer.draft.text.length;
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      composer.draft.cursor = composer.lineBoundary(false);
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      composer.draft.cursor = composer.lineBoundary(true);
    else if (key.name === "backspace") {
      const end = composer.draft.cursor;
      if (key.ctrl || key.meta) composer.moveWord(-1);
      else composer.moveCharacter(-1);
      const start = composer.draft.cursor;
      composer.remove(start, end);
    } else if (key.name === "delete" || (key.ctrl && key.name === "d")) {
      const start = composer.draft.cursor;
      composer.moveCharacter(1);
      composer.remove(start, composer.draft.cursor);
    } else if (key.ctrl && key.name === "u")
      composer.remove(
        composer.lineBoundary(false),
        composer.draft.cursor,
        true,
      );
    else if (key.ctrl && key.name === "k")
      composer.remove(composer.draft.cursor, composer.lineBoundary(true), true);
    else if (key.ctrl && key.name === "w")
      composer.remove(
        composer.draft.text
          .slice(0, composer.draft.cursor)
          .replace(/\S+\s*$/u, "").length,
        composer.draft.cursor,
        true,
      );
    else if (key.ctrl && key.name === "y") composer.yank();
    else if (key.sequence === "\u001f") composer.undoEdit();
    else if (key.ctrl && key.name === "l") {
      clearFrame();
      output.write("\u001b[2J\u001b[H");
    } else if (key.name === "tab") {
      const [matches, word] = completeChatCommand(composer.draft.text);
      if (matches.length === 1) composer.replace(matches[0]! + " ");
      else if (matches.length > 1) {
        let prefix = matches[0]!;
        while (!matches.every((match) => match.startsWith(prefix)))
          prefix = prefix.slice(0, -1);
        if (prefix.length > word.length) composer.replace(prefix);
        else {
          clearFrame();
          output.write(
            style.muted(
              clipTerminalText(matches.join("  "), (output.columns || 80) - 1),
            ) + "\n",
          );
        }
      }
    } else if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text))
      composer.insert(text);
    render();
  };

  const receiveData = (chunk: Buffer | string): void => {
    pasteBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (pasteBuffer) {
      const marker = pastedText === undefined ? "\u001b[200~" : "\u001b[201~";
      const index = pasteBuffer.indexOf(marker);
      if (index >= 0) {
        const text = pasteBuffer.slice(0, index);
        pasteBuffer = pasteBuffer.slice(index + marker.length);
        if (pastedText === undefined) {
          forwarded.write(text);
          pastedText = "";
        } else {
          if (!busy) composer.insert(safeTerminalText(pastedText + text), true);
          pastedText = undefined;
          render();
        }
        continue;
      }
      let kept = Math.min(marker.length - 1, pasteBuffer.length);
      while (kept > 0 && !marker.startsWith(pasteBuffer.slice(-kept)))
        kept -= 1;
      const text = pasteBuffer.slice(0, pasteBuffer.length - kept);
      pasteBuffer = pasteBuffer.slice(pasteBuffer.length - kept);
      if (pastedText === undefined) forwarded.write(text);
      else pastedText += text;
      break;
    }
  };

  const detach = (): void => {
    clearFrame();
    input.off("data", receiveData);
    input.off("end", close);
    input.off("close", close);
    output.off("resize", render);
    input.setRawMode(initiallyRaw);
    input.pause();
    output.write("\u001b[?2004l");
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (busy) process.emit("SIGINT");
    if (!suspended) detach();
    forwarded.off("keypress", receiveKey);
    forwarded.destroy();
    pending?.resolve(undefined);
    pending = undefined;
    lines.length = 0;
    if (initiallyFlowing) input.resume();
  };
  const attach = (): void => {
    input.on("data", receiveData);
    input.once("end", close);
    input.once("close", close);
    output.on("resize", render);
    input.setRawMode(true);
    input.resume();
    output.write("\u001b[?2004h");
  };
  const suspend = async <T>(action: () => Promise<T>): Promise<T> => {
    suspended = true;
    detach();
    try {
      return await action();
    } finally {
      suspended = false;
      if (!closed) {
        attach();
        render();
      }
    }
  };
  emitKeypressEvents(forwarded);
  forwarded.on("keypress", receiveKey);
  attach();
  return {
    readLine: async (nextPrompt) => {
      if (closed) return undefined;
      const queued = lines.shift();
      if (queued) return queued;
      prompt = nextPrompt;
      return await new Promise<ChatLine | undefined>((resolve, reject) => {
        pending = { resolve, reject };
        render();
      });
    },
    setBusy: (nextBusy) => {
      busy = nextBusy;
      if (busy) clearFrame();
      else render();
    },
    setDraft: (text) => {
      composer.replace(safeTerminalText(text), true);
      render();
    },
    suspend,
    close,
  };
};
