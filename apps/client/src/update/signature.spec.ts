import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { verifyUpdateSignature } from "./signature.js";
import { createSignedArtifact } from "./__test__/signed-update.js";

describe("update signature verification", () => {
  it("accepts a verified artifact with its signed release version", () => {
    const signed = createSignedArtifact();
    expect(() =>
      verifyUpdateSignature(
        signed.digest,
        signed.artifact.signature,
        signed.publicKey,
        "2.0.0",
      ),
    ).not.toThrow();
  });

  it("rejects damaged files, substituted signing keys, and a forged version", () => {
    const signed = createSignedArtifact();
    const other = createSignedArtifact();
    expect(() =>
      verifyUpdateSignature(
        Buffer.alloc(64),
        signed.artifact.signature,
        signed.publicKey,
        "2.0.0",
      ),
    ).toThrow(/verification/);
    expect(() =>
      verifyUpdateSignature(
        signed.digest,
        signed.artifact.signature,
        other.publicKey,
        "2.0.0",
      ),
    ).toThrow(/verification/);
    expect(() =>
      verifyUpdateSignature(
        signed.digest,
        signed.artifact.signature,
        signed.publicKey,
        "3.0.0",
      ),
    ).toThrow(/version/);
  });

  it("rejects a changed trusted comment and malformed signature packets", () => {
    const signed = createSignedArtifact();
    const changed = Buffer.from(
      Buffer.from(signed.artifact.signature, "base64")
        .toString()
        .replace("version:2.0.0", "version:3.0.0"),
    ).toString("base64");
    expect(() =>
      verifyUpdateSignature(signed.digest, changed, signed.publicKey, "3.0.0"),
    ).toThrow(/verification/);
    expect(() =>
      verifyUpdateSignature(
        signed.digest,
        "not base64",
        signed.publicKey,
        "2.0.0",
      ),
    ).toThrow(/encoding/);
  });

  it("verifies an artifact signed by the production Tauri signer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-signature-test-"));
    try {
      const execute = promisify(execFile);
      const signer = createRequire(import.meta.url).resolve(
        "@tauri-apps/cli/tauri.js",
      );
      const key = join(directory, "test.key");
      await execute(process.execPath, [
        signer,
        "signer",
        "generate",
        "--ci",
        "-p",
        "test-password",
        "-w",
        key,
      ]);
      const artifact = join(directory, "artifact.bin");
      const data = Buffer.from("Signed by Tauri");
      await writeFile(artifact, data);
      await execute(process.execPath, [
        signer,
        "signer",
        "sign",
        "-f",
        key,
        "-p",
        "test-password",
        "--app-version",
        "2.0.0",
        artifact,
      ]);
      verifyUpdateSignature(
        createHash("blake2b512").update(data).digest(),
        await readFile(`${artifact}.sig`, "utf8"),
        await readFile(`${key}.pub`, "utf8"),
        "2.0.0",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
