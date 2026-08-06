import { describe, expect, it } from "vitest";
import { MediaRuntimeError, normalizeMediaError } from "./media-runtime";

describe("media runtime error normalization", () => {
  it("preserves validated structured native errors and safely contains unstructured failures", () => {
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
    const unstructured = normalizeMediaError(
      new Error(
        "Media asset missing was not found at https://example.test/a?token=secret",
      ),
      "read_asset",
    );
    expect(unstructured).toMatchObject({
      code: "INTERNAL_ERROR",
      retryability: "retry-safe",
      context: { operation: "read_asset" },
      suggestedActions: [{ id: "refresh" }],
    });
    expect(unstructured.technicalDiagnostic).not.toContain("token=secret");
    expect(new MediaRuntimeError(unstructured).message).toBe(
      unstructured.message,
    );
  });

  it("does not derive error policy from incidental or adversarial diagnostics", () => {
    for (const diagnostic of [
      "Quoted: provider failed, output expired, license acceptance required.",
      "The user said the resource was not found, but this is not protocol state.",
      "Negated: the path is not outside the workspace.",
    ]) {
      expect(
        normalizeMediaError(new Error(diagnostic), "adversarial"),
      ).toMatchObject({
        code: "INTERNAL_ERROR",
        category: "internal",
        context: { operation: "adversarial" },
      });
    }

    expect(
      normalizeMediaError(
        {
          schemaVersion: 1,
          code: "QUOTED_RESOURCE_NOT_FOUND",
          category: "storage",
          message: "Looks structured.",
          technicalDiagnostic: "",
          context: {},
          retryability: "after-user-action",
          partialOutputsExist: false,
          suggestedActions: [],
        },
        "malformed",
      ),
    ).toMatchObject({
      code: "INTERNAL_ERROR",
      context: { operation: "malformed" },
    });
  });
});
