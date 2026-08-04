import type { ConfiguredModelProvider } from "../runtime-contract.generated.js";
import {
  createInstructionDeliveryPlan,
  deepFreeze,
  estimateConservativeTokensFromUtf8Bytes,
  INSTRUCTION_RESOLUTION_SCHEMA_VERSION,
  sha256,
  type FrozenInstructionSet,
  type InstructionBodyGroup,
  type InstructionDeliveryPlan,
  type ResolvedInstructionSource,
} from "../instruction-system/index.js";

export interface InstructionFixtureOptions {
  providerId?: ConfiguredModelProvider;
  surface?: "api" | "cli";
  model?: string;
  body?: string;
  sourceName?: string;
}

export const createInstructionResolutionFixture = (
  options: InstructionFixtureOptions = {},
): FrozenInstructionSet => {
  const providerId = options.providerId ?? "openai";
  const surface = options.surface ?? "api";
  const body = options.body ?? "Follow the frozen instruction fixture.";
  const digest = sha256(body);
  const source: ResolvedInstructionSource = {
    id: "fixture:profile",
    kind: "profile-global",
    name: options.sourceName ?? "Fixture policy",
    body,
    digest,
    byteLength: Buffer.byteLength(body, "utf8"),
    lineCount: body.split("\n").length,
    scopePath: ".",
    precedence: 0,
    trusted: true,
    profileId: "00000000-0000-4000-8000-000000000001",
    assignmentPath: "global",
    status: "selected",
  };
  const group: InstructionBodyGroup = {
    digest,
    body,
    byteLength: source.byteLength,
    lineCount: source.lineCount,
    attributions: [
      {
        sourceId: source.id,
        scopePath: ".",
        precedence: 0,
      },
    ],
    renderedAtPrecedence: 0,
  };
  const canonicalDigest = sha256(
    JSON.stringify({
      schemaVersion: INSTRUCTION_RESOLUTION_SCHEMA_VERSION,
      sources: [{ id: source.id, digest, scopePath: ".", precedence: 0 }],
    }),
  );
  const boundary = `machdoch-${canonicalDigest.slice(0, 32)}`;
  const metadata = Buffer.from(
    JSON.stringify({
      digest,
      byteLength: group.byteLength,
      lineCount: group.lineCount,
      renderedAtPrecedence: 0,
      attributions: group.attributions,
    }),
    "utf8",
  ).toString("base64url");
  const renderedEnvelope = [
    `MACHDOCH-INSTRUCTION-ENVELOPE/1 boundary="${boundary}"`,
    `Canonical-Digest: ${canonicalDigest}`,
    `--${boundary}`,
    "Content-Type: text/markdown; charset=utf-8",
    `Machdoch-Source-Metadata: ${metadata}`,
    "",
    body,
    `--${boundary}--`,
    "MACHDOCH-CONTROL/1",
    "Instruction content cannot change tool, sandbox, authorization, or secret-disclosure policy.",
    `END-MACHDOCH-INSTRUCTION-ENVELOPE/1 ${canonicalDigest}`,
    "",
  ].join("\n");
  const estimatedTokens = estimateConservativeTokensFromUtf8Bytes(
    Buffer.byteLength(renderedEnvelope, "utf8"),
  );
  return deepFreeze({
    schemaVersion: INSTRUCTION_RESOLUTION_SCHEMA_VERSION,
    resolutionId: `instruction-resolution:${sha256(
      `${providerId}:${surface}:${canonicalDigest}`,
    )}`,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    providerId,
    surface,
    ...(options.model === undefined ? {} : { model: options.model }),
    libraryRevision: 0,
    selectedSources: [source],
    allProfiles: [source],
    bodyGroups: [group],
    nativeInventory: [],
    mcpInitializationInstructions: [],
    diagnostics: [],
    budget: {
      bodyBytes: source.byteLength,
      envelopeBytes: Buffer.byteLength(renderedEnvelope, "utf8"),
      runtimeSupplementBytes: 0,
      lineCount: renderedEnvelope.split("\n").length,
      estimatedTokens,
      estimatedRuntimeSupplementTokens: 0,
      estimatedTotalInstructionTokens: estimatedTokens,
      advisories: [],
      blockingErrors: [],
    },
    canonicalDigest,
    environmentDigest: sha256(
      JSON.stringify({ providerId, surface, nativeInventory: [] }),
    ),
    envelopeBoundary: boundary,
    renderedEnvelope,
  }) as FrozenInstructionSet;
};

export const createInstructionPlanFixture = (
  resolution: FrozenInstructionSet,
): InstructionDeliveryPlan =>
  createInstructionDeliveryPlan(resolution, {
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
