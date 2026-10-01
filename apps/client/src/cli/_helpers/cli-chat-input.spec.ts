import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { createChatInput } from "./cli-chat-input.js";

const terminal = (
  history: string[] = [],
  editor?: (draft: string) => Promise<string>,
) => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (raw: boolean) {
      input.isRaw = raw;
      return input;
    }),
  });
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 40,
    rows: 12,
  });
  let transcript = "";
  output.on("data", (chunk) => {
    transcript += String(chunk);
  });
  const chat = createChatInput({
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
    history,
    ...(editor ? { editor } : {}),
  });
  return { input, output, chat, transcript: () => transcript };
};

describe("terminal prompt", () => {
  it("recalls prompts with arrow keys and restores terminal state", async () => {
    const { input, chat, transcript } = terminal(["last prompt"]);
    const line = chat.readLine("> ");
    input.write("\u001b[A\r");
    expect(await line).toEqual({ text: "last prompt" });
    chat.close();
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(transcript()).toContain("\u001b[?2004l");
  });

  it("keeps fragmented bracketed paste as one editable draft", async () => {
    const { input, chat } = terminal();
    const line = chat.readLine("> ");
    const resolved = vi.fn();
    void line.then(resolved);
    input.write("\u001b[20");
    input.write("0~/exit\r\n\tsecond\u001b[31m\u001b[20");
    input.write("1~");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    input.write("\r");
    expect(await line).toEqual({ text: "/exit\n\tsecond", pasted: true });
    chat.close();
  });

  it("supports explicit multiline input and extended Shift+Enter", async () => {
    const { input, chat } = terminal();
    const line = chat.readLine("> ");
    input.write("first\u000asecond\u001b[13;2uthird\r");
    expect(await line).toEqual({ text: "first\nsecond\nthird", pasted: true });
    chat.close();
  });

  it("opens the current draft in an editor without losing it", async () => {
    const editor = vi.fn(async (draft: string) => draft + "\nfixed");
    const { input, chat } = terminal([], editor);
    const line = chat.readLine("> ");
    input.write("draft\u0007");
    await vi.waitFor(() => expect(editor).toHaveBeenCalledWith("draft"));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.write("\r");
    expect(await line).toEqual({ text: "draft\nfixed", pasted: true });
    chat.close();
  });

  it("moves and deletes a complete emoji", async () => {
    const { input, chat } = terminal();
    const line = chat.readLine("> ");
    chat.setDraft("a👩‍💻b");
    input.write("\u001b[D\u007f\r");
    expect(await line).toEqual({ text: "ab", pasted: true });
    chat.close();
  });
});
