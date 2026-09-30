import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queryRalphJsonl } from "./ralph-jsonl-query.helper.js";

describe("bounded JSONL queries", () => {
  it("retains the requested newest matches and validates discarded records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-jsonl-query-"));
    const path = join(directory, "history.jsonl");
    try {
      await writeFile(
        path,
        [
          JSON.stringify({ id: -1, valid: false }),
          "broken JSON",
          ...Array.from({ length: 200 }, (_, id) =>
            JSON.stringify({ id, valid: true }),
          ),
        ].join("\n") + "\n",
      );
      const query = await queryRalphJsonl(path, {
        maxResults: 3,
        order: "newest",
        matches: (value) => (value as { id: number }).id % 2 === 0,
        validate: (value) =>
          (value as { valid: boolean }).valid ? [] : ["Invalid record"],
      });
      expect(query.entries.map(({ value }) => value)).toEqual(
        [198, 196, 194].map((id) => ({ id, valid: true })),
      );
      expect(query.totalCount).toBe(201);
      expect(query.invalid).toEqual([{ line: 2, error: expect.any(String) }]);
      expect(query.validation).toEqual({
        valid: false,
        errors: ["line 1: Invalid record"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
