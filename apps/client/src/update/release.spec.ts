import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLatestRelease, parseRelease } from "./release.js";
import { createSignedArtifact } from "./__test__/signed-update.js";

afterEach(() => vi.unstubAllGlobals());

function release(version = "2.0.0") {
  return {
    version,
    platforms: { "linux-headless": createSignedArtifact(version).artifact },
  };
}

describe("latest stable update discovery", () => {
  it("uses the GitHub latest manifest and compares semantic versions", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(release("10.0.0")))),
      );
    vi.stubGlobal("fetch", fetch);
    expect((await checkLatestRelease("9.9.0"))?.version).toBe("10.0.0");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://github.com/pureportal/machdoch/releases/latest/download/latest.json",
    );
    expect(await checkLatestRelease("10.0.0")).toBeNull();
    expect(await checkLatestRelease("11.0.0")).toBeNull();
  });

  it("rejects prereleases, missing metadata, foreign URLs, and invalid sizes", () => {
    expect(() => parseRelease(release("2.0.0-rc.1"))).toThrow(/stable/);
    expect(() => parseRelease({ version: "2.0.0" })).toThrow(/platforms/);
    const malformed = release();
    malformed.platforms["linux-headless"].url =
      "https://example.com/machdoch.tar.gz";
    expect(() => parseRelease(malformed)).toThrow(/URL/);
    malformed.platforms["linux-headless"] = createSignedArtifact().artifact;
    malformed.platforms["linux-headless"].size = -1;
    expect(() => parseRelease(malformed)).toThrow(/artifact/);
  });

  it("reports incomplete release publication, rate limits, offline failures, and oversized manifests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(checkLatestRelease("1.0.0")).rejects.toThrow(
      /no signed updates/,
    );
    fetch.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(checkLatestRelease("1.0.0")).rejects.toThrow(/429/);
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(checkLatestRelease("1.0.0")).rejects.toThrow(/offline/);
    fetch.mockResolvedValueOnce(new Response(" ".repeat(1024 * 1024 + 1)));
    await expect(checkLatestRelease("1.0.0")).rejects.toThrow(/too large/);
  });

  it("rejects a signed package mapped to a different platform", () => {
    const artifact = createSignedArtifact().artifact;
    expect(() =>
      parseRelease({
        version: "2.0.0",
        platforms: { "linux-x86_64-appimage": artifact },
      }),
    ).toThrow(/platform/);
    expect(() =>
      parseRelease({
        version: "2.0.0",
        platforms: {
          "linux-x86_64-appimage": {
            ...artifact,
            url: "https://github.com/pureportal/machdoch/releases/download/v2.0.0/machdoch-linux-amd64.AppImage",
          },
        },
      }),
    ).toThrow(/filename/);
  });

  it("rejects duplicate signed metadata and unsigned version substitutions", () => {
    const malformed = release();
    const artifact = malformed.platforms["linux-headless"];
    const original = Buffer.from(artifact.signature, "base64").toString();
    artifact.signature = Buffer.from(
      original.replace(
        "file:machdoch-headless.tar.gz",
        "file:machdoch-headless.tar.gz\tfile:machdoch-headless.tar.gz",
      ),
    ).toString("base64");
    expect(() => parseRelease(malformed)).toThrow(/one version and filename/);
    artifact.signature = Buffer.from(
      original.replace("version:2.0.0", "version:3.0.0"),
    ).toString("base64");
    expect(() => parseRelease(malformed)).toThrow(/version and filename/);
  });
});
