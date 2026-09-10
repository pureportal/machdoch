import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordRalphJsonAttemptFailure } from "./ralph-json-attempt-diagnostics.helper.js";

describe("JSON attempt evidence", () => {
  it("redacts configured secrets in diagnostics and preserves the complete response text", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ralph-json-evidence-redaction-"),
    );
    const secret = "configured-diagnostic-secret";
    vi.stubEnv("OPENAI_API_KEY", secret);
    const responseText = `${secret}${"é".repeat(40_000)} token=example`;
    try {
      const failure = await recordRalphJsonAttemptFailure({
        runId: "run",
        runDirectory: directory,
        operationId: "operation",
        block: { id: "json", type: "UTILITY" },
        config: { provider: "openai", model: "test-model" },
        attempt: 1,
        stage: "parse",
        errors: [`Invalid JSON: ${secret}`],
        responseText,
        logger: undefined,
      });
      expect(failure.errors).toEqual(["Invalid JSON: [redacted]"]);
      expect(failure.persistenceError).toBeUndefined();
      const evidence = JSON.parse(
        await readFile(failure.evidencePath!, "utf8"),
      );
      expect(evidence).toMatchObject({
        errors: failure.errors,
        responseChars: responseText.length,
        responseBytes: Buffer.byteLength(responseText, "utf8"),
        responseRedacted: true,
        responseText: responseText.replaceAll(secret, "[redacted]"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects evidence writes redirected outside the run directory", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "ralph-json-evidence-link-"));
    const directory = join(testRoot, "run");
    const outside = join(testRoot, "outside");
    try {
      await mkdir(directory);
      await mkdir(outside);
      await symlink(
        outside,
        join(directory, "json-attempts"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const failure = await recordRalphJsonAttemptFailure({
        runId: "run",
        runDirectory: directory,
        operationId: "operation",
        block: { id: "json", type: "UTILITY" },
        config: { provider: "openai", model: "test-model" },
        attempt: 1,
        stage: "parse",
        errors: ["Unexpected end of JSON input"],
        responseText: '{"count":',
        logger: undefined,
      });
      expect(failure).toMatchObject({
        errors: ["Unexpected end of JSON input"],
        persistenceError:
          "JSON attempt evidence must stay inside the run directory.",
      });
      expect(failure.evidencePath).toBeUndefined();
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
