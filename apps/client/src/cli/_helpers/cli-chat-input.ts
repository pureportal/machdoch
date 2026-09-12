import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import {
  completeChatCommand,
  InteractiveInputCancelledError,
} from "./cli-interactive-commands.js";

export interface ChatLine {
  text: string;
  pasted?: boolean;
}

export interface ChatInput {
  readLine(prompt: string): Promise<ChatLine | undefined>;
  setBusy(busy: boolean): void;
  suspend<T>(action: () => Promise<T>): Promise<T>;
  close(): void;
}

export const createChatInput = (
  options: { input?: ReadStream; output?: WriteStream } = {},
): ChatInput => {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const initiallyRaw = input.isRaw === true;
  const initiallyFlowing = input.readableFlowing === true;
  const lines: ChatLine[] = [];
  let pending:
    | {
        resolve: (line: ChatLine | undefined) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let terminal: Interface;
  let forwarded: PassThrough;
  let closed = false;
  let suspended = false;
  let busy = false;
  let history: string[] = [];
  let pasteBuffer = "";
  let pasteText: string | undefined;
  let draft: string | undefined;
  const decoder = new StringDecoder("utf8");

  const clearDraft = (): void => {
    terminal.write(null, { ctrl: true, name: "u" });
    terminal.write(null, { ctrl: true, name: "k" });
  };

  const acceptLine = (text: string): void => {
    const line: ChatLine =
      draft === undefined ? { text } : { text: draft + text, pasted: true };
    draft = undefined;
    if (pending) {
      const request = pending;
      pending = undefined;
      request.resolve(line);
    } else lines.push(line);
  };
  const showPaste = (text: string): void => {
    const clean = stripVTControlCharacters(text)
      .replace(/\r\n?/gu, "\n")
      .replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : " "));
    if (!clean.includes("\n")) {
      terminal.write(clean);
      return;
    }
    draft =
      (draft ?? "") +
      terminal.line.slice(0, terminal.cursor) +
      clean +
      terminal.line.slice(terminal.cursor);
    clearDraft();
    output.write(
      `\nPasted ${draft.split("\n").length} lines. Enter sends; Ctrl+C discards.\n`,
    );
    terminal.prompt();
  };
  const receiveData = (chunk: Buffer | string): void => {
    pasteBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (pasteBuffer) {
      const marker = pasteText === undefined ? "\u001b[200~" : "\u001b[201~";
      const index = pasteBuffer.indexOf(marker);
      if (index >= 0) {
        const text = pasteBuffer.slice(0, index);
        pasteBuffer = pasteBuffer.slice(index + marker.length);
        if (pasteText === undefined) {
          forwarded.write(text);
          pasteText = "";
        } else {
          const completed = pasteText + text;
          pasteText = undefined;
          showPaste(completed);
        }
        continue;
      }
      let kept = Math.min(marker.length - 1, pasteBuffer.length);
      while (kept > 0 && !marker.startsWith(pasteBuffer.slice(-kept)))
        kept -= 1;
      const text = pasteBuffer.slice(0, pasteBuffer.length - kept);
      pasteBuffer = pasteBuffer.slice(pasteBuffer.length - kept);
      if (pasteText === undefined) forwarded.write(text);
      else pasteText += text;
      break;
    }
  };
  const interrupt = (): void => {
    lines.length = 0;
    if (busy) {
      process.emit("SIGINT");
      return;
    }
    draft = undefined;
    clearDraft();
    output.write("\n");
    const request = pending;
    pending = undefined;
    request?.reject(new InteractiveInputCancelledError());
  };
  const detach = (): void => {
    input.off("data", receiveData);
    input.off("end", close);
    input.off("close", close);
    terminal.off("close", close);
    terminal.close();
    forwarded.destroy();
    input.setRawMode(initiallyRaw);
    input.pause();
    output.write("\u001b[?2004l");
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (busy) process.emit("SIGINT");
    if (!suspended) detach();
    pending?.resolve(undefined);
    pending = undefined;
    lines.length = 0;
    if (initiallyFlowing) input.resume();
  };
  const attach = (): void => {
    forwarded = new PassThrough();
    terminal = createInterface({
      input: forwarded,
      output,
      terminal: true,
      completer: completeChatCommand,
      history,
      removeHistoryDuplicates: true,
    });
    terminal.on("line", acceptLine);
    terminal.on("history", (nextHistory: string[]) => {
      history = nextHistory;
    });
    terminal.on("SIGINT", interrupt);
    terminal.once("close", close);
    input.on("data", receiveData);
    input.once("end", close);
    input.once("close", close);
    input.setRawMode(true);
    input.resume();
    output.write("\u001b[?2004h");
  };
  attach();
  return {
    readLine: async (prompt) => {
      if (closed) return undefined;
      const queued = lines.shift();
      if (queued) return queued;
      return await new Promise<ChatLine | undefined>((resolve, reject) => {
        pending = { resolve, reject };
        terminal.setPrompt(prompt);
        terminal.prompt(true);
      });
    },
    setBusy: (nextBusy) => {
      busy = nextBusy;
    },
    suspend: async (action) => {
      suspended = true;
      detach();
      try {
        return await action();
      } finally {
        suspended = false;
        if (!closed) attach();
      }
    },
    close,
  };
};
