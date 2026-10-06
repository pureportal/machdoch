import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readLastRalphLogSequence } from "./read-ralph-log-sequence.helper.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(() => {
      throw new Error("Logs must be streamed");
    }),
  };
});

it("continues log numbering across large histories and a torn crash tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-log-sequence-"));
  const paths = {
    simpleJsonlPath: join(directory, "simple.jsonl"),
    traceJsonlPath: join(directory, "trace.jsonl"),
  };
  try {
    await writeFile(
      paths.simpleJsonlPath,
      `${JSON.stringify({ sequence: 7 })}\n`,
    );
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ sequence: index + 8, message: "🌍".repeat(256) }),
    );
    await writeFile(
      paths.traceJsonlPath,
      `${lines.join("\n")}\n{"sequence":2008`,
    );
    expect(await readLastRalphLogSequence(paths)).toBe(2_007);
    await rm(paths.traceJsonlPath);
    expect(await readLastRalphLogSequence(paths)).toBe(7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports unreadable logs instead of resetting the recovered sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-log-unreadable-"));
  try {
    await expect(
      readLastRalphLogSequence({
        simpleJsonlPath: directory,
        traceJsonlPath: join(directory, "missing"),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
