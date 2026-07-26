import { describe, expect, it } from "vitest";
import { MediaRuntimeError, normalizeMediaError } from "./media-runtime";

describe("media runtime error normalization", () => {
  it("preserves structured native errors and normalizes legacy failures", () => {
    const nativeFailure = {
      schemaVersion: 1 as const,
      code: "REMOTE_RETRY_COST_RISK" as const,
      category: "provider" as const,
      message: "Retrying could create a duplicate remote charge.",
      technicalDiagnostic: "acceptance is unknown",
      context: {
        nodeId: "node:generate",
        providerId: "provider:test",
        modelId: null,
        runtimeId: null,
        runId: "run:test",
        assetId: null,
        operation: "media_retry_run",
      },
      retryability: "reconcile-first" as const,
      partialOutputsExist: true,
      suggestedActions: [
        {
          id: "review-run" as const,
          label: "Review provider job",
          description: "Reconcile before retrying.",
        },
      ],
    };

    expect(normalizeMediaError(nativeFailure, "fallback")).toEqual(
      nativeFailure,
    );
    const legacy = normalizeMediaError(
      new Error(
        "Media asset missing was not found at https://example.test/a?token=secret",
      ),
      "read_asset",
    );
    expect(legacy).toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      retryability: "after-user-action",
      context: { operation: "read_asset" },
      suggestedActions: [{ id: "refresh" }],
    });
    expect(legacy.technicalDiagnostic).not.toContain("token=secret");
    expect(new MediaRuntimeError(legacy).message).toBe(legacy.message);
  });
});
