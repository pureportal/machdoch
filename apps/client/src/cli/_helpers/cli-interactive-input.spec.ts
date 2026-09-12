import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatInput } from "./cli-chat-input.js";
import { readPastedTask } from "./cli-chat-paste.js";
import { createTerminalPrompter } from "./cli-prompter.js";
import {
  completeChatCommand,
  splitInteractiveArguments,
} from "./cli-interactive-commands.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const terminalStreams = () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => {
      input.isRaw = raw;
      return input;
    }),
  });
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    rows: 12,
    columns: 50,
  });
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString();
  });
  return {
    input,
    output,
    options: {
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
    },
    rendered: () => rendered,
  };
};

describe("interactive argument handling", () => {
  it("preserves Windows paths and quoted arguments without shell evaluation", () => {
    expect(
      splitInteractiveArguments(
        "attach \"C:\\My Project\\a.ts\" 'file two.ts'",
      ),
    ).toEqual(["attach", "C:\\My Project\\a.ts", "file two.ts"]);
    expect(
      splitInteractiveArguments('config set value "$(echo secret)"'),
    ).toEqual(["config", "set", "value", "$(echo secret)"]);
    expect(() => splitInteractiveArguments('attach "unfinished')).toThrow(
      "Close the",
    );
    expect(completeChatCommand("/mod")).toEqual([["/model", "/mode"], "/mod"]);
    expect(completeChatCommand("describe this")).toEqual([[], "describe this"]);
  });
});

describe("terminal menus", () => {
  it("retains rapidly pasted input, supports cursor editing, and restores terminal state", async () => {
    const streams = terminalStreams();
    const prompter = createTerminalPrompter(streams.options);
    cleanups.push(() => prompter.close());
    const result = prompter.input("Name");
    streams.input.write("abc\u001b[D\u001b[3~d\r");
    await expect(result).resolves.toBe("abd");
    prompter.close();
    expect(streams.input.isRaw).toBe(false);
    expect(streams.input.listenerCount("keypress")).toBe(0);
    expect(streams.input.isPaused()).toBe(true);
    expect(streams.rendered()).not.toContain("\u001b[2J");
    expect(streams.rendered()).toContain("\u001b[?25h");
  });

  it("masks a complete pasted secret and does not submit embedded newlines", async () => {
    const streams = terminalStreams();
    const prompter = createTerminalPrompter(streams.options);
    cleanups.push(() => prompter.close());
    const result = prompter.input("API key", { secret: true });
    streams.input.write("\u001b[200~sensitive-token\u001b[201~\r");
    await expect(result).resolves.toBe("sensitive-token");
    expect(streams.rendered()).not.toContain("sensitive-token");
  });

  it("filters long menus and preserves validation feedback during navigation", async () => {
    const streams = terminalStreams();
    const prompter = createTerminalPrompter(streams.options);
    cleanups.push(() => prompter.close());
    prompter.status("Enter a positive number.", "error");
    const result = prompter.select(
      "Models",
      Array.from({ length: 30 }, (_, index) => ({
        value: String(index),
        label: `Model ${index}`,
      })),
    );
    streams.input.write("Model 29\r");
    await expect(result).resolves.toBe("29");
    expect(streams.rendered()).toContain("Search: Model 29");
    expect(
      streams.rendered().match(/Enter a positive number\./gu)?.length,
    ).toBeGreaterThan(2);
  });

  it("settles a pending menu on EOF and Ctrl+C", async () => {
    for (const closeWithEof of [true, false]) {
      const streams = terminalStreams();
      const prompter = createTerminalPrompter(streams.options);
      cleanups.push(() => prompter.close());
      const result = prompter.select("Mode", [{ value: "ask", label: "Ask" }]);
      const check = expect(result).rejects.toThrow("Cancelled.");
      if (closeWithEof) streams.input.emit("end");
      else streams.input.write("\u0003");
      await check;
      prompter.close();
      expect(streams.input.isRaw).toBe(false);
    }
  });
});

describe("chat input", () => {
  it("captures a whole /paste sequence and subsequent commands in one input chunk", async () => {
    const streams = terminalStreams();
    const input = createChatInput(streams.options);
    cleanups.push(() => input.close());
    const first = input.readLine("ask> ");
    streams.input.write("/paste\rline one\r\rline two\r/end\r/help\r");
    await expect(first).resolves.toEqual({ text: "/paste" });
    await expect(readPastedTask(input, "ask")).resolves.toEqual({
      task: "line one\n\nline two",
      mode: "ask",
    });
    await expect(input.readLine("ask> ")).resolves.toEqual({ text: "/help" });
  });

  it("requires Enter after bracketed multiline paste, even when markers arrive separately", async () => {
    const streams = terminalStreams();
    const input = createChatInput(streams.options);
    cleanups.push(() => input.close());
    const line = input.readLine("ask> ");
    const settled = vi.fn();
    void line.then(settled);
    streams.input.write("\u001b[20");
    streams.input.write("0~/exit\nthis is task text\n\u001b[2");
    streams.input.write("01~");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    streams.input.write("\r");
    await expect(line).resolves.toEqual({
      text: "/exit\nthis is task text\n",
      pasted: true,
    });
  });

  it("cancels a draft without closing the conversation, then handles EOF", async () => {
    const streams = terminalStreams();
    const input = createChatInput(streams.options);
    cleanups.push(() => input.close());
    const line = input.readLine("ask> ");
    const check = expect(line).rejects.toThrow("Cancelled.");
    streams.input.write("discard this\u0003");
    await check;
    const next = input.readLine("ask> ");
    streams.input.write("hello\r");
    await expect(next).resolves.toEqual({ text: "hello" });
    const closed = input.readLine("ask> ");
    streams.input.write("\u0004");
    await expect(closed).resolves.toBeUndefined();
    expect(streams.input.isRaw).toBe(false);
    expect(streams.input.isPaused()).toBe(true);
    expect(streams.output.listenerCount("resize")).toBe(0);
  });

  it("forwards Ctrl+C to the running task and resumes after a nested menu", async () => {
    const streams = terminalStreams();
    const input = createChatInput(streams.options);
    cleanups.push(() => input.close());
    const cancel = vi.fn();
    process.on("SIGINT", cancel);
    try {
      input.setBusy(true);
      streams.input.write("\u0003");
      expect(cancel).toHaveBeenCalledOnce();
      input.setBusy(false);
      await input.suspend(async () => {
        expect(streams.input.isRaw).toBe(false);
        expect(streams.input.listenerCount("data")).toBe(0);
      });
      const line = input.readLine("ask> ");
      streams.input.write("/status\r");
      await expect(line).resolves.toEqual({ text: "/status" });
    } finally {
      process.off("SIGINT", cancel);
    }
  });
});
