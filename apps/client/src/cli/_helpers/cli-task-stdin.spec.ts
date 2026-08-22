import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readTaskFromStdin } from "./cli-task-stdin.js";

describe("task stdin transport", () => {
  it("preserves large multiline UTF-8 task content without an argv round trip", async () => {
    const body = `${"line with ünicode\n".repeat(40_000)}final line`;

    await expect(readTaskFromStdin(Readable.from([body]))).resolves.toBe(body);
  });

  it("rejects empty, invalid, and oversized input", async () => {
    await expect(readTaskFromStdin(Readable.from([" \r\n "]))).rejects.toThrow(
      "empty",
    );
    await expect(
      readTaskFromStdin(Readable.from([Buffer.from([0xff])])),
    ).rejects.toThrow("valid UTF-8");
    await expect(
      readTaskFromStdin(Readable.from([Buffer.alloc(33)]), 32),
    ).rejects.toThrow("exceeds");
  });
});
