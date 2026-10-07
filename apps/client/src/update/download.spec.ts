import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadUpdate } from "./download.js";
import { createSignedArtifact } from "./__test__/signed-update.js";

afterEach(() => vi.unstubAllGlobals());

describe("verified update download", () => {
  it("writes only a complete artifact with valid checksum and signature", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-download-test-"));
    try {
      const signed = createSignedArtifact();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(new Uint8Array(signed.data))),
      );
      const destination = join(directory, "update.tar.gz");
      await downloadUpdate(
        signed.artifact,
        "2.0.0",
        signed.publicKey,
        destination,
      );
      expect(await readFile(destination)).toEqual(signed.data);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["truncated", "oversized", "checksum", "signature"])(
    "removes the staged file after a %s failure",
    async (failure) => {
      const directory = await mkdtemp(
        join(tmpdir(), "machdoch-download-test-"),
      );
      try {
        const signed = createSignedArtifact();
        const bytes =
          failure === "truncated"
            ? signed.data.subarray(0, -1)
            : failure === "oversized"
              ? Buffer.concat([signed.data, Buffer.from("!")])
              : signed.data;
        if (failure === "checksum") signed.artifact.sha256 = "0".repeat(64);
        if (failure === "signature")
          signed.artifact.signature = createSignedArtifact().artifact.signature;
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes))),
        );
        await expect(
          downloadUpdate(
            signed.artifact,
            "2.0.0",
            signed.publicKey,
            join(directory, "update.tar.gz"),
          ),
        ).rejects.toThrow();
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
