import { describe, expect, it } from "vitest";
import type { MediaFlow, MediaFlowLayout } from "./contracts.js";
import {
  canonicalizeMediaValue,
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "./canonicalize.js";
import nativeVideoRevision from "./canonical-video.fixture.json" with { type: "json" };

describe("native flow canonicalization", () => {
  it("matches the saved desktop revision for a generated video first frame", () => {
    const flow = nativeVideoRevision.flow as MediaFlow;
    expect(createMediaFlowFingerprint(flow)).toBe(
      nativeVideoRevision.executionDigest,
    );
    expect(createMediaFlowDocumentDigest(flow)).toBe(
      nativeVideoRevision.documentDigest,
    );
    expect(
      createMediaFlowLayoutDigest(
        nativeVideoRevision.layout as MediaFlowLayout,
      ),
    ).toBe(nativeVideoRevision.layoutDigest);
  });

  it("orders object keys by Unicode value independently of locale", () => {
    const value = { "🙂": 1, "\uE000": 2, a_b: 3, "a-b": 4, a: 5, Z: 6 };
    expect(Object.keys(canonicalizeMediaValue(value) as object)).toEqual([
      "Z",
      "a",
      "a-b",
      "a_b",
      "\uE000",
      "🙂",
    ]);
  });
});
