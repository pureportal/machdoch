import process from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { InteractiveInputCancelledError } from "./cli-interactive-commands.js";
import { createCliStyle } from "./cli-terminal.js";

export interface InteractiveMenuChoice {
  value: string;
  label: string;
  description?: string;
}

export interface InteractivePrompter {
  select(
    title: string,
    choices: readonly InteractiveMenuChoice[],
    options?: {
      currentValue?: string;
      hint?: string;
    },
  ): Promise<string | undefined>;
  input(
    title: string,
    options?: {
      initialValue?: string;
      secret?: boolean;
      hint?: string;
    },
  ): Promise<string | undefined>;
  status(message: string, kind?: "success" | "error"): void;
  close(message?: string): void;
}

export const moveMenuSelection = (
  index: number,
  keyName: string | undefined,
  count: number,
): number => {
  if (count <= 0 || keyName === "home") return 0;
  if (keyName === "end") return count - 1;
  if (keyName === "up") return (index - 1 + count) % count;
  if (keyName === "down") return (index + 1) % count;
  if (keyName === "pageup") return Math.max(0, index - 10);
  if (keyName === "pagedown") return Math.min(count - 1, index + 10);
  return index;
};

const visibleText = (value: string): string =>
  stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");

export const createTerminalPrompter = (
  options: {
    input?: ReadStream;
    output?: WriteStream;
    title?: string;
  } = {},
): InteractivePrompter => {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error("This menu requires a terminal.");
  const style = createCliStyle({ isTTY: true });
  const initiallyRaw = input.isRaw === true;
  const initiallyFlowing = input.readableFlowing === true;
  type KeyEvent = { text: string; key: Key; pasted: boolean };
  const keys: KeyEvent[] = [];
  let waiter: ((event: KeyEvent | undefined) => void) | undefined;
  let closed = false;
  let pasted = false;
  let message = "";
  let messageKind: "success" | "error" = "success";
  let render: (() => void) | undefined;
  let frameRows = 0;
  let frameColumn = 0;

  const clearFrame = (): void => {
    output.write(frameRows ? `\r\u001b[${frameRows}A\u001b[J` : "\r\u001b[J");
    frameRows = 0;
    frameColumn = 0;
  };
  const writeFrame = (text: string): void => {
    output.write(text);
    const width = output.columns || 80;
    for (const character of stripVTControlCharacters(text)) {
      if (character === "\n") {
        frameRows += 1;
        frameColumn = 0;
      } else {
        if (frameColumn >= width) {
          frameRows += 1;
          frameColumn = 0;
        }
        frameColumn += 1;
      }
    }
  };

  const receiveKey = (text: string | undefined, key: Key): void => {
    if (key.sequence === "\u001b[200~") {
      pasted = true;
      return;
    }
    if (key.sequence === "\u001b[201~") {
      pasted = false;
      return;
    }
    const event = { text: text ?? "", key, pasted };
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(event);
    } else keys.push(event);
  };
  const close = (finalMessage?: string): void => {
    if (closed) return;
    closed = true;
    input.off("keypress", receiveKey);
    input.off("end", handleEnd);
    input.off("close", handleEnd);
    output.off("resize", handleResize);
    input.setRawMode(initiallyRaw);
    if (!initiallyFlowing) input.pause();
    clearFrame();
    output.write("\u001b[?2004l\u001b[?25h");
    waiter?.(undefined);
    waiter = undefined;
    keys.length = 0;
    if (finalMessage) output.write(`${visibleText(finalMessage)}\n`);
  };
  const handleEnd = (): void => close();
  const handleResize = (): void => render?.();
  const readKey = async (): Promise<KeyEvent> => {
    const event = closed
      ? undefined
      : (keys.shift() ??
        (await new Promise<KeyEvent | undefined>((resolve) => {
          waiter = resolve;
        })));
    if (
      !event ||
      (!event.pasted &&
        event.key.ctrl &&
        ["c", "d"].includes(event.key.name ?? ""))
    ) {
      throw new InteractiveInputCancelledError();
    }
    return event;
  };
  const header = (title: string, hint?: string, inputPrompt = false): void => {
    clearFrame();
    writeFrame(`${style.heading(options.title ?? "Machdoch")}\n`);
    writeFrame(
      `${style.muted(inputPrompt ? "Enter save · Esc back · Ctrl+U clear" : "↑↓ choose · Enter select · Esc back · Type to search")}\n`,
    );
    if (message) writeFrame(`${style[messageKind](visibleText(message))}\n`);
    writeFrame(`\n${style.label(visibleText(title))}\n`);
    if (hint) writeFrame(`${style.muted(visibleText(hint))}\n`);
  };

  emitKeypressEvents(input);
  input.on("keypress", receiveKey);
  input.once("end", handleEnd);
  input.once("close", handleEnd);
  output.on("resize", handleResize);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?2004h");

  return {
    select: async (title, choices, selectOptions) => {
      if (!choices.length) return undefined;
      let index = Math.max(
        0,
        choices.findIndex(
          (choice) => choice.value === selectOptions?.currentValue,
        ),
      );
      let search = "";
      let filtered = [...choices];
      output.write("\u001b[?25l");
      try {
        while (true) {
          render = () => {
            header(title, selectOptions?.hint);
            if (search) writeFrame(`Search: ${visibleText(search)}\n`);
            const pageSize = Math.max(1, (output.rows || 24) - frameRows - 3);
            const start = Math.max(
              0,
              Math.min(
                index - Math.floor(pageSize / 2),
                filtered.length - pageSize,
              ),
            );
            const width = Math.max(8, (output.columns || 80) - 5);
            for (const [offset, choice] of filtered
              .slice(start, start + pageSize)
              .entries()) {
              const active = start + offset === index;
              const label = visibleText(choice.label);
              const clipped =
                Array.from(label).length > width
                  ? `${Array.from(label)
                      .slice(0, width - 1)
                      .join("")}…`
                  : label;
              writeFrame(
                `${active ? style.command(`> ${clipped}`) : `  ${clipped}`}\n`,
              );
            }
            if (!filtered.length) writeFrame("No matches.\n");
            if (filtered.length > pageSize)
              writeFrame(style.muted(`${index + 1}/${filtered.length}\n`));
          };
          render();
          const { text, key, pasted: isPasted } = await readKey();
          if (key.name === "escape" && !isPasted) {
            if (!search) return undefined;
            search = "";
          } else if (
            (key.name === "return" || key.name === "enter") &&
            !isPasted
          ) {
            if (filtered[index]) return filtered[index]!.value;
          } else if (key.name === "backspace") {
            search = Array.from(search).slice(0, -1).join("");
          } else if (!key.ctrl && !key.meta && text && !/\p{Cc}/u.test(text)) {
            search += text;
          } else {
            index = moveMenuSelection(index, key.name, filtered.length);
            continue;
          }
          filtered = choices.filter((choice) =>
            `${choice.label} ${choice.value}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          );
          index = 0;
        }
      } finally {
        render = undefined;
        output.write("\u001b[?25h");
      }
    },
    input: async (title, inputOptions) => {
      const value = Array.from(
        inputOptions?.secret ? "" : (inputOptions?.initialValue ?? ""),
      );
      let cursor = value.length;
      try {
        while (true) {
          render = () => {
            header(title, inputOptions?.hint, true);
            const width = Math.max(8, (output.columns || 80) - 4);
            const start = Math.max(0, cursor - width + 1);
            const shown = value.slice(start, start + width);
            writeFrame(
              `\n> ${inputOptions?.secret ? "*".repeat(shown.length) : visibleText(shown.join(""))}`,
            );
            const afterCursor =
              Math.min(shown.length, value.length - start) - (cursor - start);
            if (afterCursor > 0) output.write(`\u001b[${afterCursor}D`);
          };
          render();
          const { text, key, pasted: isPasted } = await readKey();
          if (key.name === "escape" && !isPasted) return undefined;
          if ((key.name === "return" || key.name === "enter") && !isPasted) {
            const result = value.join("").trim();
            if (result) return result;
            message = "Enter a value or press Esc.";
            messageKind = "error";
          } else if (key.name === "left") cursor = Math.max(0, cursor - 1);
          else if (key.name === "right")
            cursor = Math.min(value.length, cursor + 1);
          else if (key.name === "home" || (key.ctrl && key.name === "a"))
            cursor = 0;
          else if (key.name === "end" || (key.ctrl && key.name === "e"))
            cursor = value.length;
          else if (key.ctrl && key.name === "u") {
            value.splice(0, cursor);
            cursor = 0;
          } else if (key.ctrl && key.name === "k") value.splice(cursor);
          else if (key.name === "backspace" && cursor > 0) {
            value.splice(cursor - 1, 1);
            cursor -= 1;
          } else if (key.name === "delete") value.splice(cursor, 1);
          else if (!key.ctrl && !key.meta && text) {
            const characters = Array.from(visibleText(text));
            value.splice(cursor, 0, ...characters);
            cursor += characters.length;
          }
        }
      } finally {
        render = undefined;
      }
    },
    status: (nextMessage, kind = "success") => {
      message = nextMessage;
      messageKind = kind;
    },
    close,
  };
};
